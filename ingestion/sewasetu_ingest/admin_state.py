"""Administrator state (R2 ``admin/`` prefix) applied during ingestion.

 * uploads   - officially obtained PDFs added through the admin panel
 * overrides - evidence-backed corrections to service fields
 * reviews   - approve/reject decisions, baked into the release so it is self-contained

Reviews are bound to the record's content hash: an approval only applies if the
service content is unchanged since the reviewer looked at it.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .normalizers.service import compute_content_hash, source_id_for
from .publisher.store import ObjectStore
from .util import normalize_text, sha256_hex


@dataclass
class AdminState:
    decisions: dict[str, dict] = field(default_factory=dict)
    overrides: dict[str, dict] = field(default_factory=dict)
    uploads: list[tuple[dict, bytes]] = field(default_factory=list)  # (metadata, pdf bytes)

    @classmethod
    def load(cls, store: ObjectStore | None) -> "AdminState":
        if store is None:
            return cls()
        st = cls()
        raw = store.get("admin/review-state.json")
        if raw:
            st.decisions = json.loads(raw).get("decisions", {})
        for key in store.list_keys("admin/overrides/"):
            data = store.get(key)
            if data:
                o = json.loads(data)
                st.overrides[o["service_id"]] = o
        idx = store.get("admin/uploads/index.json")
        for meta in json.loads(idx) if idx else []:
            pdf = store.get(f"admin/uploads/{meta['sha256']}.pdf")
            if pdf and sha256_hex(pdf) == meta["sha256"]:  # integrity check of what the admin uploaded
                st.uploads.append((meta, pdf))
        return st


def apply_override(service: dict, override: dict) -> list[dict]:
    """Applies a reviewer correction. Returns extra chunks that carry the evidence source.

    The corrected text gets its own chunks whose ``source_url`` is the evidence URL the
    reviewer supplied, so answers citing it point at that evidence - not at the portal page.
    """
    patch, ev = override["patch"], override["evidence"]
    sid = service["service_id"]
    src_id = source_id_for(ev["source_url"])
    service["sources"].append({
        "source_id": src_id, "source_url": ev["source_url"], "title": f"Reviewer-supplied evidence: {normalize_text(ev['note'])[:120]}",
        "publisher_or_department": service["department"]["name"] if service["department"] else None,
        "document_type": "admin_upload", "retrieved_at": override["updated_at"], "published_at": None, "last_modified_at": None,
        "content_hash": sha256_hex(json.dumps(patch, sort_keys=True)), "page_or_section": None, "extraction_method": "manual",
    })
    chunks: list[dict] = []

    def add(section: str, field_name: str, texts: list[str], target: list[dict] | None):
        if not texts:
            return
        chunk_id = f"{sid}#{section}#m0"
        text = f"{service['service_name']} - {field_name} (corrected by reviewer; evidence: {ev['source_url']}):\n" + "\n".join(f"- {t}" for t in texts)
        chunks.append({
            "chunk_id": chunk_id, "service_id": sid, "department_id": service["department"]["department_id"] if service["department"] else None,
            "section_type": section, "text": text, "source_url": ev["source_url"], "source_title": f"Reviewer-supplied evidence for {service['service_name']}",
            "page_or_section": normalize_text(ev["note"])[:120], "retrieved_at": override["updated_at"], "content_hash": sha256_hex(text), "language": "en",
        })
        if target is not None:
            target[:] = [{"text": t, "source_chunk_id": chunk_id} for t in texts]  # replaces extracted statements

    if "eligibility" in patch:
        add("eligibility", "eligibility", patch["eligibility"], service["eligibility"])
    if "appeal_procedure" in patch:
        add("appeal", "appeal procedure", patch["appeal_procedure"], service["appeal_procedure"])
    if "grievance_procedure" in patch:
        add("grievance", "grievance procedure", patch["grievance_procedure"], service["grievance_procedure"])
    if "application_steps" in patch:
        chunk_id = f"{sid}#steps#m0"
        add("steps", "application steps", patch["application_steps"], None)
        service["application_steps"] = [{"step": i + 1, "text": t, "source_chunk_id": chunk_id} for i, t in enumerate(patch["application_steps"])]
    for field_name in ("service_name_as", "description", "designated_authority", "delivery_method"):
        if field_name in patch:
            service[field_name] = patch[field_name]
    if patch.get("processing_time_text"):
        add("timeline", "processing time", [patch["processing_time_text"]], None)
        service["processing_time"] = {"status": "published", "value": None, "unit": None, "text": patch["processing_time_text"],
                                      "conditions": [], "source_chunk_ids": [f"{sid}#timeline#m0"]}
    service["content_hash"] = compute_content_hash(service)
    return chunks


def apply_review(service: dict, decision: dict | None) -> None:
    """Bakes an approve/reject decision into the record (approval only if the hash still matches)."""
    if not decision:
        return
    if decision["decision"] == "rejected":
        service["publication_status"] = "rejected"
    elif decision["content_hash"] == service["content_hash"]:
        service["publication_status"] = "verified"
        service["last_verified_at"] = decision["reviewed_at"]
