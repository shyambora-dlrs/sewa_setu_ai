"""Ingestion report: what was discovered, extracted, changed, duplicated and what failed."""
from __future__ import annotations

from dataclasses import dataclass, field

from .util import utc_now_iso


@dataclass
class IngestionReport:
    release_id: str
    started_at: str = field(default_factory=utc_now_iso)
    finished_at: str | None = None
    totals: dict = field(default_factory=lambda: {
        "services_discovered": 0, "services_extracted": 0, "services_failed": 0, "services_new": 0, "services_changed": 0,
        "services_unchanged": 0, "services_removed": 0, "pages_extracted": 0, "pdfs_discovered": 0, "pdfs_extracted": 0,
        "pdfs_failed": 0, "pdfs_ocr": 0, "pdfs_needing_review": 0, "admin_uploads": 0, "http_requests": 0,
    })
    failures: list[dict] = field(default_factory=list)
    services: list[dict] = field(default_factory=list)
    pdfs: list[dict] = field(default_factory=list)
    duplicates: dict = field(default_factory=lambda: {"service_urls": [], "service_content": [], "pdf_content": []})
    removed: list[str] = field(default_factory=list)
    unavailable_fields: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def bump(self, key: str, n: int = 1) -> None:
        self.totals[key] += n

    def fail(self, url: str, stage: str, error: str) -> None:
        self.failures.append({"url": url, "stage": stage, "error": error})

    def finish(self) -> dict:
        self.finished_at = utc_now_iso()
        return self.to_dict()

    def to_dict(self) -> dict:
        return {
            "release_id": self.release_id, "started_at": self.started_at, "finished_at": self.finished_at, "totals": self.totals,
            "failures": self.failures, "services": self.services, "pdfs": self.pdfs, "duplicates": self.duplicates,
            "removed": self.removed, "unavailable_fields": self.unavailable_fields, "notes": self.notes,
        }
