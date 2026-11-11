"""Validates a generated release directory before it may be published.

Implements spec 8.3 plus structural checks: JSON-Schema validation of every
record (schemas exported from the Zod definitions the Worker uses), referential
integrity (chunk/service/source ids), index consistency and file checksums.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from jsonschema import Draft202012Validator

from ..util import sha256_hex

SCHEMA_DIR = Path(__file__).resolve().parents[3] / "knowledge-schemas"


@dataclass
class ValidationReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    checked: dict[str, int] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict:
        return {"status": "passed" if self.passed else "failed", "errors": self.errors[:500], "warnings": self.warnings[:500], "checked": self.checked}


def _validator(name: str) -> Draft202012Validator:
    return Draft202012Validator(json.loads((SCHEMA_DIR / name).read_text()))


def _load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def _schema_errors(validator: Draft202012Validator, doc, label: str, limit: int = 3) -> list[str]:
    return [f"{label}: {'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message[:160]}" for e in list(validator.iter_errors(doc))[:limit]]


def validate_release(root: Path) -> ValidationReport:
    rep = ValidationReport()
    err = rep.errors.append

    manifest_path = root / "manifest.json"
    if not manifest_path.exists():
        err("manifest.json is missing")
        return rep
    manifest = _load(manifest_path)
    for m in _schema_errors(_validator("manifest.schema.json"), manifest, "manifest"):
        err(m)

    # ---- checksums of every listed file ----
    listed = {f["path"]: f for f in manifest.get("files", [])}
    for rel, f in listed.items():
        p = root / rel
        if not p.exists():
            err(f"listed file missing: {rel}")
        elif sha256_hex(p.read_bytes()) != f["sha256"]:
            err(f"checksum mismatch: {rel}")
    on_disk = {str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()} - {"manifest.json", "reports/validation-report.json"}
    for extra in sorted(on_disk - set(listed)):
        err(f"file not listed in manifest: {extra}")

    # ---- chunks ----
    chunk_ids: list[str] = []
    chunk_validator = _validator("chunk.schema.json")
    chunk_files = sorted((root / "chunks").glob("chunk-shard-*.json"))
    size = manifest.get("chunk_shard_size", 0)
    for i, cf in enumerate(chunk_files):
        shard = _load(cf)
        if i < len(chunk_files) - 1 and len(shard) != size:
            err(f"{cf.name}: expected {size} chunks, found {len(shard)}")
        for c in shard:
            for m in _schema_errors(chunk_validator, c, f"chunk {c.get('chunk_id')}", 1):
                err(m)
            chunk_ids.append(c["chunk_id"])
            if not str(c.get("source_url", "")).startswith("https://"):
                err(f"chunk {c['chunk_id']}: source_url must be https")
    if len(set(chunk_ids)) != len(chunk_ids):
        err("duplicate chunk ids")
    rep.checked["chunks"] = len(chunk_ids)
    if manifest.get("chunk_count") != len(chunk_ids):
        err(f"manifest chunk_count {manifest.get('chunk_count')} != actual {len(chunk_ids)}")
    chunk_set = set(chunk_ids)

    # ---- services ----
    service_validator = _validator("service.schema.json")
    services: dict[str, dict] = {}
    for sf in sorted((root / "catalog" / "services").glob("*.json")):
        s = _load(sf)
        for m in _schema_errors(service_validator, s, f"service {sf.stem}"):
            err(m)
        if s.get("service_id") != sf.stem:
            err(f"service file {sf.name} has mismatching id {s.get('service_id')}")
        if s.get("service_id") in services:
            err(f"duplicate service id {s.get('service_id')}")
        services[sf.stem] = s
    rep.checked["services"] = len(services)
    if manifest.get("service_count") != len(services):
        err(f"manifest service_count {manifest.get('service_count')} != actual {len(services)}")

    verified = 0
    for sid, s in services.items():
        if not s.get("sources"):
            err(f"{sid}: no official source URL")
        for src in s.get("sources", []):
            if not str(src.get("source_url", "")).startswith("https://"):
                err(f"{sid}: source url must be https ({src.get('source_url')})")
        fees = s.get("fees", {})
        if any(i.get("amount") is not None for i in fees.get("items", [])) or fees.get("amount") is not None:
            if not fees.get("source_chunk_ids"):
                err(f"{sid}: fee has no supporting source chunk")
        pt = s.get("processing_time", {})
        if pt.get("status") == "published" and not pt.get("source_chunk_ids"):
            err(f"{sid}: processing time has no supporting source chunk")
        for d in s.get("required_documents", []) + s.get("conditional_documents", []):
            if d.get("requirement") == "mandatory" and not (d.get("source_text") and d.get("source_chunk_id")):
                err(f"{sid}: mandatory document '{d.get('name')}' lacks supporting source text/chunk")
            if d.get("source_chunk_id") and d["source_chunk_id"] not in chunk_set:
                err(f"{sid}: document chunk reference missing: {d['source_chunk_id']}")
        for cid in fees.get("source_chunk_ids", []) + pt.get("source_chunk_ids", []):
            if cid not in chunk_set:
                err(f"{sid}: chunk reference missing: {cid}")
        if s.get("publication_status") == "verified":
            verified += 1
            if not s.get("last_verified_at"):
                err(f"{sid}: verified without last_verified_at")
        if s.get("extraction_warnings"):
            rep.warnings.append(f"{sid}: {len(s['extraction_warnings'])} extraction warning(s)")
    if manifest.get("verified_service_count") != verified:
        err(f"manifest verified_service_count {manifest.get('verified_service_count')} != actual {verified}")

    for cid in chunk_ids:
        sid = cid.split("#", 1)[0]
        if not sid.startswith("general~") and sid not in services:
            err(f"chunk {cid} references unknown service")

    # ---- summaries & sources ----
    sums = _load(root / "catalog" / "summaries.json") if (root / "catalog" / "summaries.json").exists() else None
    if sums is None:
        err("catalog/summaries.json missing")
    else:
        sv = _validator("service-summary.schema.json")
        for s in sums:
            for m in _schema_errors(sv, s, f"summary {s.get('service_id')}", 1):
                err(m)
        if {s["service_id"] for s in sums} != set(services):
            err("summaries do not match service files")
    if not (root / "catalog" / "sources.json").exists():
        err("catalog/sources.json missing")

    # ---- BM25 consistency ----
    meta_path = root / manifest.get("retrieval", {}).get("keyword_index", "indexes/bm25-v1/meta.json")
    if not meta_path.exists():
        err("BM25 meta missing")
    else:
        meta = _load(meta_path)
        for m in _schema_errors(_validator("bm25-meta.schema.json"), meta, "bm25 meta"):
            err(m)
        if meta.get("doc_ids") != chunk_ids:
            err("BM25 doc_ids do not match chunk order")
        for n in range(meta.get("shard_count", 0)):
            if not (meta_path.parent / f"shard-{n:02d}.json").exists():
                err(f"BM25 shard missing: {n}")

    # ---- embeddings (optional) ----
    emb = manifest.get("retrieval", {}).get("embedding_index")
    if emb:
        emb_meta = _load(root / emb)
        for m in _schema_errors(_validator("embedding-meta.schema.json"), emb_meta, "embedding meta"):
            err(m)
        if emb_meta.get("doc_ids") != chunk_ids:
            err("embedding doc_ids do not match chunk order")
    return rep
