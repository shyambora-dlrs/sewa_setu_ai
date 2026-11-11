"""Assembles an immutable release directory and publishes it to R2 atomically.

Atomic-publish contract (spec 6.1 / 8.6):
  1. every release object is uploaded under ``releases/<release_id>/``;
  2. every uploaded object is verified (size + sha256 metadata);
  3. ONLY THEN ``current.json`` is rewritten - the single mutable pointer;
  4. a failure at any earlier step raises and leaves ``current.json`` untouched.
Old releases are kept for rollback (``previous_release_ids``) and pruned beyond a retention count.
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from pathlib import Path

from .. import SCHEMA_VERSION
from ..chunkers.chunker import chunk_service
from ..embeddings.build import SHARD_SIZE as EMB_SHARD, build_embedding_index
from ..indexers.bm25 import build_bm25
from ..util import sha256_hex, utc_now_iso
from ..validators.validate import ValidationReport, validate_release
from .store import ObjectStore

CHUNK_SHARD_SIZE = 200


def new_release_id(now: datetime | None = None) -> str:
    """``YYYY-MM-DDTHHMMSSZ-<6 hex>``: lexicographic order == chronological order."""
    now = now or datetime.now(timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H%M%SZ')}-{secrets.token_hex(3)}"


def _dump(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def summarize(service: dict) -> dict:
    """Light catalogue record used for listing/searching without loading full services."""
    return {
        "service_id": service["service_id"], "service_name": service["service_name"], "service_name_as": service["service_name_as"],
        "category": service["category"],
        "department_id": service["department"]["department_id"] if service["department"] else None,
        "department_name": service["department"]["name"] if service["department"] else None,
        "publication_status": service["publication_status"], "content_hash": service["content_hash"],
        "last_verified_at": service["last_verified_at"],
        "has_fees": service["fees"]["status"] == "published",
        "has_documents": bool(service["required_documents"] or service["conditional_documents"]),
        "has_steps": bool(service["application_steps"]),
        "has_processing_time": service["processing_time"]["status"] == "published",
        "warning_count": len(service["extraction_warnings"]),
    }


def build_release(
    out_dir: Path,
    *,
    services: list[dict],
    extra_chunks: list[dict],
    extra_sources: list[dict],
    release_id: str,
    report: dict,
    embedding_provider=None,
    now: str | None = None,
) -> dict:
    """Writes the full release to ``out_dir`` and returns the manifest. Does not validate or upload."""
    out_dir.mkdir(parents=True, exist_ok=True)
    now = now or utc_now_iso()
    files: dict[str, bytes] = {}

    services = sorted(services, key=lambda s: s["service_id"])
    chunks: list[dict] = []
    for s in services:
        chunks.extend(s.pop("_manual_chunks", []))  # reviewer-supplied correction chunks
        chunks.extend(chunk_service(s))
    chunks.extend(extra_chunks)

    # Departments derived from the services that actually exist.
    departments = {s["department"]["department_id"]: s["department"] for s in services if s["department"]}
    sources = {src["source_id"]: src for s in services for src in s["sources"]}
    sources.update({src["source_id"]: src for src in extra_sources})

    files["catalog/summaries.json"] = _dump([summarize(s) for s in services])
    for s in services:
        files[f"catalog/services/{s['service_id']}.json"] = _dump(s)
    files["catalog/departments.json"] = _dump(sorted(departments.values(), key=lambda d: d["name"]))
    files["catalog/sources.json"] = _dump(sources)

    for i in range(0, len(chunks), CHUNK_SHARD_SIZE):
        files[f"chunks/chunk-shard-{i // CHUNK_SHARD_SIZE:03d}.json"] = _dump(chunks[i : i + CHUNK_SHARD_SIZE])

    meta, shards = build_bm25(chunks)
    files["indexes/bm25-v1/meta.json"] = _dump(meta)
    for n, shard in enumerate(shards):
        files[f"indexes/bm25-v1/shard-{n:02d}.json"] = _dump(shard)

    emb_path = emb_model = None
    if embedding_provider is not None and chunks:
        emb_meta, emb_shards = build_embedding_index(chunks, embedding_provider, EMB_SHARD)
        emb_path, emb_model = "indexes/embeddings-v1/meta.json", emb_meta["model"]
        files[emb_path] = _dump(emb_meta)
        for n, shard in enumerate(emb_shards):
            files[f"indexes/embeddings-v1/shard-{n:03d}.json"] = _dump(shard)

    files["reports/extraction-report.json"] = _dump(report)

    for rel, data in files.items():
        p = out_dir / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    manifest = {
        "release_id": release_id, "schema_version": SCHEMA_VERSION, "generated_at": now,
        "source_count": len(sources), "service_count": len(services),
        "verified_service_count": sum(1 for s in services if s["publication_status"] == "verified"),
        "chunk_count": len(chunks), "chunk_shard_size": CHUNK_SHARD_SIZE,
        "retrieval": {"keyword_index": "indexes/bm25-v1/meta.json", "embedding_index": emb_path, "embedding_model": emb_model},
        "files": [{"path": rel, "size": len(data), "sha256": sha256_hex(data)} for rel, data in sorted(files.items())],
        "validation_status": "passed",
    }
    (out_dir / "manifest.json").write_bytes(_dump(manifest))
    return manifest


def validate_and_record(out_dir: Path) -> ValidationReport:
    """Validates the release and writes ``reports/validation-report.json`` + the final validation status."""
    rep = validate_release(out_dir)
    (out_dir / "reports").mkdir(exist_ok=True)
    (out_dir / "reports" / "validation-report.json").write_bytes(_dump(rep.to_dict()))
    if not rep.passed:
        m = json.loads((out_dir / "manifest.json").read_text())
        m["validation_status"] = "failed"
        (out_dir / "manifest.json").write_bytes(_dump(m))
    return rep


class PublishError(RuntimeError):
    pass


def publish_release(out_dir: Path, store: ObjectStore, *, keep_releases: int = 4) -> dict:
    """Uploads, verifies and activates a validated release. Returns the new ``current.json`` pointer."""
    manifest = json.loads((out_dir / "manifest.json").read_text())
    if manifest["validation_status"] != "passed":
        raise PublishError("refusing to publish a release that failed validation")
    release_id = manifest["release_id"]
    prefix = f"releases/{release_id}/"

    # Step 1+2: upload everything (manifest last among release files) and verify each object.
    paths = sorted(p for p in out_dir.rglob("*") if p.is_file() and p.name != "manifest.json")
    paths.append(out_dir / "manifest.json")
    uploaded: list[tuple[str, int, str]] = []
    for p in paths:
        rel = str(p.relative_to(out_dir))
        data = p.read_bytes()
        digest = sha256_hex(data)
        store.put(prefix + rel, data, "application/json", {"sha256": digest})
        uploaded.append((rel, len(data), digest))
    for rel, size, digest in uploaded:
        head = store.head(prefix + rel)
        if not head or head["size"] != size or head["metadata"].get("sha256") != digest:
            raise PublishError(f"upload verification failed for {rel}; current.json NOT updated")

    # Step 3: switch the pointer - the only mutable object - as the very last operation.
    previous = store.get("current.json")
    prev_ids: list[str] = []
    if previous:
        old = json.loads(previous)
        prev_ids = [old["release_id"]] + [x for x in old.get("previous_release_ids", []) if x != old["release_id"]]
    pointer = {"release_id": release_id, "published_at": utc_now_iso(), "schema_version": manifest["schema_version"],
               "previous_release_ids": [x for x in prev_ids if x != release_id][: max(0, keep_releases - 1)]}  # rollback targets == retained releases
    store.put("current.json", _dump(pointer), "application/json")

    prune_releases(store, keep=keep_releases, protect={release_id, *pointer["previous_release_ids"]})
    return pointer


def prune_releases(store: ObjectStore, *, keep: int, protect: set[str]) -> list[str]:
    """Deletes releases beyond the newest ``keep`` ones, never touching protected (current/rollback) releases."""
    ids = sorted((p[len("releases/"):-1] for p in store.list_prefixes("releases/")), reverse=True)
    removed = []
    for rid in ids[keep:]:
        if rid in protect:
            continue
        for key in store.list_keys(f"releases/{rid}/"):
            store.delete(key)
        removed.append(rid)
    return removed


def activate_release(store: ObjectStore, release_id: str) -> dict:
    """Rollback / roll-forward: points ``current.json`` at an existing, validated release."""
    raw = store.get(f"releases/{release_id}/manifest.json")
    if raw is None:
        raise PublishError(f"release {release_id} does not exist")
    manifest = json.loads(raw)
    if manifest.get("validation_status") != "passed":
        raise PublishError("release did not pass validation")
    cur = store.get("current.json")
    prev = []
    if cur:
        old = json.loads(cur)
        prev = [old["release_id"]] + old.get("previous_release_ids", [])
    pointer = {"release_id": release_id, "published_at": utc_now_iso(), "schema_version": manifest["schema_version"],
               "previous_release_ids": [x for x in dict.fromkeys(prev) if x != release_id][:5]}
    store.put("current.json", _dump(pointer), "application/json")
    return pointer
