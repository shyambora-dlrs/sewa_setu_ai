"""Builds schema-conformant service records from extraction results.

Rules: unknown stays unknown (``null``/``[]``/``not_published``); nothing is filled
by guessing; ``publication_status`` is always ``draft`` here - only an
administrator decision can later turn a record into ``verified``.
"""
from __future__ import annotations

import re

from ..crawler.discovery import ServiceRef
from ..crawler.http import FetchResult
from ..extractors.html_service import ExtractedService
from ..util import canonical_json, normalize_text, sha256_hex, slugify

SERVICE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,200}$")
TIME_RE = re.compile(r"(?P<n>\d+)\s*(?P<u>working\s+days?|days?|hours?|months?)", re.I)


def source_id_for(url: str) -> str:
    """Stable public id for a source URL (used by /api/v1/sources/:id)."""
    return "src-" + sha256_hex(url)[:16]


def service_id_for(ref: ServiceRef) -> str:
    slug = ref.slug.lower()
    return slug if SERVICE_ID_RE.match(slug) else slugify(ref.name, 200)


def department_id_for(name: str) -> str:
    return slugify(name, 120)


def _statements(items: list[str]) -> list[dict]:
    return [{"text": normalize_text(t), "source_chunk_id": None} for t in items if normalize_text(t)]


def _requirement(doc) -> dict:
    return {
        "name": doc.name, "requirement": doc.requirement, "applies_to": None,
        "condition": doc.condition, "source_text": doc.source_text, "source_chunk_id": None,
    }


def parse_processing_time(lines: list[str]) -> dict:
    """Only sets numeric value/unit when the text contains exactly one unambiguous duration."""
    if not lines:
        return {"status": "not_published", "value": None, "unit": None, "text": None, "conditions": [], "source_chunk_ids": []}
    text = normalize_text(" ".join(lines))
    matches = TIME_RE.findall(text)
    value = unit = None
    if len(matches) == 1:
        n, u = matches[0]
        u = u.lower()
        unit = "working_days" if u.startswith("working") else "days" if u.startswith("day") else "hours" if u.startswith("hour") else "months"
        value = float(n)
    return {"status": "published", "value": value, "unit": unit, "text": text, "conditions": [], "source_chunk_ids": []}


def compute_content_hash(service: dict) -> str:
    """Hash of the *meaning* of a record, used to detect real changes and to bind approvals.

    Excludes timestamps, publication status, verification date, chunk ids and
    retrieval metadata so re-fetching unchanged content never invalidates a review.
    """
    def strip(items, drop):
        return [{k: v for k, v in i.items() if k not in drop} for i in items]

    basis = {
        "name": service["service_name"], "name_as": service["service_name_as"], "category": service["category"],
        "department": service["department"], "description": service["description"],
        "eligibility": strip(service["eligibility"], {"source_chunk_id"}),
        "documents": strip(service["required_documents"] + service["conditional_documents"], {"source_chunk_id"}),
        "steps": strip(service["application_steps"], {"source_chunk_id"}),
        "fees": {"items": service["fees"]["items"], "status": service["fees"]["status"]},
        "time": {k: service["processing_time"][k] for k in ("status", "value", "unit", "text")},
        "authority": service["designated_authority"], "delivery": service["delivery_method"],
        "appeal": strip(service["appeal_procedure"], {"source_chunk_id"}),
        "grievance": strip(service["grievance_procedure"], {"source_chunk_id"}),
        "apply": service["application_url"], "page": service["official_page_url"],
    }
    return sha256_hex(canonical_json(basis))


def build_service(ref: ServiceRef, ex: ExtractedService, fetched: FetchResult, extracted_at: str) -> dict:
    """Converts one extraction into a draft service record."""
    docs = [_requirement(d) for d in ex.documents]
    fee_items = [
        {"label": f.label, "amount": f.amount, "unit": f.unit, "condition": f.condition, "raw_text": f.raw_text} for f in ex.fees
    ]
    # A single unconditional, unit-less fee is the service's total; otherwise keep the itemised list only.
    single = [f for f in fee_items if f["condition"] is None and f["unit"] is None and f["amount"] is not None]
    amount = single[0]["amount"] if len(fee_items) == 1 and single else None
    department_name = ex.department or ref.department
    notes = normalize_text("\n".join(ex.notes))[:20000]  # verbatim page text that fits no structured field

    service = {
        "service_id": service_id_for(ref),
        "service_name": normalize_text(ex.title or ref.name),
        "service_name_as": None,
        "category": ref.category,
        "department": {"department_id": department_id_for(department_name), "name": department_name} if department_name else None,
        "description": notes or None,
        "eligibility": _statements(ex.eligibility),
        "required_documents": [d for d in docs if d["requirement"] != "conditional"],
        "conditional_documents": [d for d in docs if d["requirement"] == "conditional"],
        "application_steps": [{"step": i + 1, "text": normalize_text(t), "source_chunk_id": None} for i, t in enumerate(ex.steps)],
        "fees": {
            "status": "published" if fee_items else "not_published", "amount": amount, "currency": "INR", "items": fee_items,
            "conditions": sorted({f["condition"] for f in fee_items if f["condition"]}), "source_chunk_ids": [],
        },
        "processing_time": parse_processing_time(ex.timeline_text),
        "designated_authority": None,
        "delivery_method": None,
        "rejection_conditions": [],
        "appeal_procedure": _statements(ex.appeal_text),
        "grievance_procedure": _statements(ex.grievance_text),
        "application_url": ex.apply_url if ex.apply_url and ex.apply_url.startswith("https://") else None,
        "official_page_url": ref.url,
        "sources": [{
            "source_id": source_id_for(ref.url), "source_url": ref.url,
            "title": f"{normalize_text(ex.title or ref.name)} - Sewa Setu service page",
            "publisher_or_department": department_name, "document_type": "service_page",
            "retrieved_at": fetched.retrieved_at, "published_at": None, "last_modified_at": None,
            "content_hash": fetched.sha256 or sha256_hex(""), "page_or_section": None, "extraction_method": "html",
        }],
        "publication_status": "draft",
        "last_verified_at": None,
        "extracted_at": extracted_at,
        "content_hash": "pending",
        "extraction_warnings": list(ex.warnings),
    }
    service["content_hash"] = compute_content_hash(service)
    return service
