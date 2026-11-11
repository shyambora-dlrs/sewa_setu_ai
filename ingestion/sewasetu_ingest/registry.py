"""Source registry: remembers what was fetched so the next run can detect changes.

Stored at ``sources/source-registry.json`` in R2. For each URL it keeps the latest
content hash, HTTP validators (ETag/Last-Modified) and the history of hashes - which
is how "retain previous versions when official text changes" is satisfied (the raw
snapshots themselves are stored content-addressed and never overwritten).
"""
from __future__ import annotations

import json

from .publisher.store import ObjectStore

REGISTRY_KEY = "sources/source-registry.json"


class SourceRegistry:
    def __init__(self, entries: dict[str, dict] | None = None):
        self.entries: dict[str, dict] = entries or {}
        self.seen_this_run: set[str] = set()

    @classmethod
    def load(cls, store: ObjectStore | None) -> "SourceRegistry":
        raw = store.get(REGISTRY_KEY) if store else None
        return cls(json.loads(raw) if raw else {})

    def validators(self) -> dict[str, dict]:
        """HTTP validators for conditional requests."""
        return {u: {"etag": e.get("etag"), "last_modified": e.get("last_modified"), "sha256": e.get("sha256")} for u, e in self.entries.items()}

    def record(self, url: str, sha256: str, retrieved_at: str, etag: str | None, last_modified: str | None, kind: str,
               semantic: str | None = None) -> str:
        """Records a successful fetch; returns ``new`` | ``changed`` | ``unchanged``.

        ``sha256`` is the hash of the raw response (used for the content-addressed snapshot and
        conditional requests). Dynamic pages can embed per-request tokens, so when a ``semantic``
        hash of the *extracted content* is supplied, change detection compares that instead.
        """
        self.seen_this_run.add(url)
        e = self.entries.get(url)
        if e is None:
            self.entries[url] = {"kind": kind, "sha256": sha256, "semantic": semantic, "etag": etag, "last_modified": last_modified,
                                 "first_seen": retrieved_at, "last_seen": retrieved_at, "last_changed": retrieved_at,
                                 "history": [{"sha256": sha256, "at": retrieved_at}]}
            return "new"
        e.update({"last_seen": retrieved_at, "etag": etag or e.get("etag"), "last_modified": last_modified or e.get("last_modified")})
        changed = (e.get("semantic") != semantic) if semantic is not None and e.get("semantic") is not None else (e["sha256"] != sha256)
        raw_changed = e["sha256"] != sha256
        e["sha256"] = sha256
        if semantic is not None:
            e["semantic"] = semantic
        if changed:
            e["last_changed"] = retrieved_at
        if raw_changed:
            e["history"] = (e.get("history", []) + [{"sha256": sha256, "at": retrieved_at}])[-20:]
        return "changed" if changed else "unchanged"

    def missing_this_run(self, kind: str) -> list[str]:
        """URLs of ``kind`` known from earlier runs but not seen now (possibly removed)."""
        return sorted(u for u, e in self.entries.items() if e.get("kind") == kind and u not in self.seen_this_run)

    def dump(self) -> bytes:
        return json.dumps(self.entries, ensure_ascii=False, indent=1, sort_keys=True).encode()
