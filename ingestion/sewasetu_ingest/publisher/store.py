"""Object-store abstraction: R2 (S3-compatible) in production, a local directory in tests/dry-runs."""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Protocol


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes, content_type: str = "application/json", metadata: dict[str, str] | None = None) -> None: ...
    def get(self, key: str) -> bytes | None: ...
    def head(self, key: str) -> dict | None: ...
    def list_prefixes(self, prefix: str) -> list[str]: ...
    def list_keys(self, prefix: str) -> list[str]: ...
    def delete(self, key: str) -> None: ...


class LocalDirObjectStore:
    """Filesystem-backed store with the same semantics (used for tests and ``--store local:<dir>``)."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def _p(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents and p != self.root.resolve():
            raise ValueError("key escapes store root")
        return p

    def put(self, key, data, content_type="application/json", metadata=None):
        p = self._p(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        (p.parent / (p.name + ".meta")).write_text(repr(metadata or {}))

    def get(self, key):
        p = self._p(key)
        return p.read_bytes() if p.is_file() else None

    def head(self, key):
        p = self._p(key)
        if not p.is_file():
            return None
        meta = eval((p.parent / (p.name + ".meta")).read_text() or "{}") if (p.parent / (p.name + ".meta")).exists() else {}  # noqa: S307 - self-written repr of a dict[str,str]
        return {"size": p.stat().st_size, "metadata": meta}

    def list_prefixes(self, prefix):
        base = self._p(prefix.rstrip("/")) if prefix.rstrip("/") else self.root
        if not base.is_dir():
            return []
        return sorted(f"{prefix}{d.name}/" for d in base.iterdir() if d.is_dir())

    def list_keys(self, prefix):
        base = self.root
        return sorted(str(p.relative_to(base)) for p in base.rglob("*") if p.is_file() and not p.name.endswith(".meta") and str(p.relative_to(base)).startswith(prefix))

    def delete(self, key):
        p = self._p(key)
        if p.is_file():
            p.unlink()
        meta = p.parent / (p.name + ".meta")
        if meta.exists():
            meta.unlink()
        # Object stores have no directories: drop now-empty parents so prefix listings stay truthful.
        parent = p.parent
        while parent != self.root.resolve() and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent


class S3ObjectStore:
    """Cloudflare R2 through the S3-compatible API (``boto3`` is imported lazily)."""

    def __init__(self, account_id: str, bucket: str, access_key_id: str, secret_access_key: str, client=None):
        if client is None:
            import boto3  # lazy: only needed for real uploads

            client = boto3.client(
                "s3", endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com", aws_access_key_id=access_key_id,
                aws_secret_access_key=secret_access_key, region_name="auto",
            )
        self.client, self.bucket = client, bucket

    def put(self, key, data, content_type="application/json", metadata=None):
        for attempt in range(4):
            try:
                self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type, Metadata=metadata or {})
                return
            except Exception:  # noqa: BLE001 - transient network/5xx errors are retried, then re-raised
                if attempt == 3:
                    raise
                time.sleep(2**attempt)

    def get(self, key):
        try:
            return self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read()
        except self.client.exceptions.NoSuchKey:
            return None

    def head(self, key):
        try:
            r = self.client.head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "response", {}).get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return None
            raise
        return {"size": r["ContentLength"], "metadata": r.get("Metadata", {})}

    def list_prefixes(self, prefix):
        out, token = [], None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": prefix, "Delimiter": "/"}
            if token:
                kw["ContinuationToken"] = token
            r = self.client.list_objects_v2(**kw)
            out += [p["Prefix"] for p in r.get("CommonPrefixes", [])]
            token = r.get("NextContinuationToken")
            if not token:
                return sorted(out)

    def list_keys(self, prefix):
        out, token = [], None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            r = self.client.list_objects_v2(**kw)
            out += [o["Key"] for o in r.get("Contents", [])]
            token = r.get("NextContinuationToken")
            if not token:
                return sorted(out)

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=key)


def store_from_env(spec: str) -> ObjectStore:
    """``local:<dir>`` or ``r2`` (credentials from the environment, never from files)."""
    if spec.startswith("local:"):
        return LocalDirObjectStore(Path(spec[6:]))
    if spec == "r2":
        need = ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET_NAME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
        missing = [n for n in need if not os.environ.get(n)]
        if missing:
            raise RuntimeError(f"missing environment variables for R2: {', '.join(missing)}")
        return S3ObjectStore(os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["R2_BUCKET_NAME"], os.environ["AWS_ACCESS_KEY_ID"], os.environ["AWS_SECRET_ACCESS_KEY"])
    raise ValueError(f"unknown store spec: {spec}")
