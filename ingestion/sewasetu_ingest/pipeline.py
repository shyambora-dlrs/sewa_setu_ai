"""End-to-end ingestion orchestration.

discover -> fetch -> extract -> normalise -> (PDFs, guideline pages, admin uploads)
-> overrides/reviews -> de-duplicate -> build release -> validate.

The network layer (``fetcher``) and the object store are injected, which is what makes the
whole pipeline testable offline with fixtures. Failures never abort the run silently: each
one is recorded in the ingestion report; only systemic failures (no directory reachable,
failure ratio above the configured limit) abort so a broken release is never published.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .admin_state import AdminState, apply_override, apply_review
from .chunkers.chunker import chunk_text_blocks
from .config import CrawlPolicy, Sources
from .crawler.discovery import DocLink, ServiceRef, discover_document_links, merge_refs, parse_directory
from .crawler.http import PoliteFetcher
from .extractors.html_generic import extract_sections
from .extractors.html_service import extract_service_page
from .extractors.pdf import extract_pdf
from .normalizers.dedupe import dedupe_by_canonical_url, find_duplicate_content
from .normalizers.service import build_service, source_id_for
from .publisher.release import build_release, new_release_id, validate_and_record
from .publisher.store import ObjectStore
from .registry import SourceRegistry
from .report import IngestionReport
from .util import canonical_url, normalize_text, utc_now_iso


class PipelineError(RuntimeError):
    """A systemic failure that must stop the run (nothing is published)."""


@dataclass
class PipelineOptions:
    output: Path
    sources: Sources
    policy: CrawlPolicy
    store: ObjectStore | None = None  # read admin state / registry / previous release from here
    max_services: int | None = None
    skip_pdfs: bool = False
    ocr: bool = True
    embedding_provider: object | None = None
    max_failure_ratio: float = 0.10
    release_id: str | None = None


@dataclass
class PipelineResult:
    report: dict
    manifest: dict
    validation_passed: bool
    registry: SourceRegistry
    snapshots: list[tuple[str, str]] = field(default_factory=list)  # (sha256, kind) of raw sources to archive


def _pdf_allowed(fetcher: PoliteFetcher, url: str) -> bool:
    return fetcher.is_allowed_host(url, pdf=True)


def run_pipeline(opts: PipelineOptions, fetcher: PoliteFetcher) -> PipelineResult:
    release_id = opts.release_id or new_release_id()
    report = IngestionReport(release_id=release_id)
    registry = SourceRegistry.load(opts.store)
    fetcher.validators = registry.validators()
    admin = AdminState.load(opts.store)
    snapshots: list[tuple[str, str]] = []
    extracted_at = utc_now_iso()

    # ---------------------------------------------------------------- 1. discovery
    groups: list[list[ServiceRef]] = []
    reachable = 0
    for d in opts.sources.directories:
        res = fetcher.fetch(d["url"], stage="discover-directory")
        if not res.ok:
            report.fail(d["url"], "discover-directory", res.error or "unknown")
            continue
        reachable += 1
        registry.record(d["url"], res.sha256 or "", res.retrieved_at, res.etag, res.last_modified, "directory")
        snapshots.append((res.sha256 or "", "html"))
        groups.append(parse_directory(res.content.decode("utf-8", "ignore"), d["url"], d["category"]))
    if reachable == 0:
        raise PipelineError("no service directory page could be fetched; refusing to build a release")

    refs, dupes = merge_refs(groups)
    # Distinct pages can share a slug only through crawler error; keep the first.
    seen_ids: set[str] = set()
    unique_refs = []
    for r in refs:
        if r.slug in seen_ids:
            report.duplicates["service_urls"].append(r.url)
            continue
        seen_ids.add(r.slug)
        unique_refs.append(r)
    report.duplicates["service_urls"] += [r.url for r in dupes]
    if opts.max_services:
        unique_refs = unique_refs[: opts.max_services]
    report.totals["services_discovered"] = len(unique_refs)

    previous = _PreviousRelease(opts.store)

    # ---------------------------------------------------------------- 2. services
    services: list[dict] = []
    pdf_candidates: list[tuple[str, str, str | None]] = []  # (url, label, service_id)
    for ref in unique_refs:
        res = fetcher.fetch(ref.url, stage="service-page")
        if not res.ok:
            report.fail(ref.url, "service-page", res.error or "unknown")
            carried = previous.service(ref.slug)
            if carried:  # transient failure must not make a published service vanish
                carried["extraction_warnings"] = list(carried.get("extraction_warnings", [])) + ["source fetch failed in latest run; carried forward from previous release"]
                services.append(carried)
                report.notes.append(f"carried forward {ref.slug}")
            report.bump("services_failed")
            continue
        snapshots.append((res.sha256 or "", "html"))
        ex = extract_service_page(res.content.decode("utf-8", "ignore"), ref.url)
        service = build_service(ref, ex, res, extracted_at)
        # Change detection uses the hash of the extracted content (raw HTML can embed per-request tokens).
        change = registry.record(ref.url, res.sha256 or "", res.retrieved_at, res.etag, res.last_modified, "service", semantic=service["content_hash"])
        services.append(service)
        report.bump("services_extracted")
        report.bump({"new": "services_new", "changed": "services_changed", "unchanged": "services_unchanged"}[change])
        report.services.append({"service_id": service["service_id"], "url": ref.url, "change": change, "warnings": service["extraction_warnings"]})
        for field_name, bad in (("fees", service["fees"]["status"] == "not_published"), ("processing_time", service["processing_time"]["status"] == "not_published"),
                                ("eligibility", not service["eligibility"]), ("appeal_procedure", not service["appeal_procedure"])):
            if bad:
                report.unavailable_fields[field_name] = report.unavailable_fields.get(field_name, 0) + 1
        for url, label in ex.pdf_links:
            pdf_candidates.append((_abs(url, ref.url), label, service["service_id"]))

    if report.totals["services_discovered"] and report.totals["services_failed"] / report.totals["services_discovered"] > opts.max_failure_ratio:
        raise PipelineError(f"{report.totals['services_failed']}/{report.totals['services_discovered']} service pages failed - above the allowed ratio; nothing published")

    # ---------------------------------------------------------------- 3. guideline pages + linked PDFs
    general_chunks: list[dict] = []
    extra_sources: list[dict] = []
    for page in opts.sources.guideline_pages:
        res = fetcher.fetch(page["url"], stage="guideline-page")
        if not res.ok:
            report.fail(page["url"], "guideline-page", res.error or "unknown")
            continue
        registry.record(page["url"], res.sha256 or "", res.retrieved_at, res.etag, res.last_modified, "guideline")
        snapshots.append((res.sha256 or "", "html"))
        html = res.content.decode("utf-8", "ignore")
        title, sections = extract_sections(html, page.get("title", page["url"]))
        sid = source_id_for(page["url"])
        extra_sources.append(_source(sid, page["url"], page.get("title", title), "Sewa Setu", "html_page", res.retrieved_at, res.sha256 or "", "html"))
        general_chunks += chunk_text_blocks(
            [(s.heading, s.text, None) for s in sections], chunk_prefix=f"general~{sid}", source_url=page["url"],
            source_title=page.get("title", title), retrieved_at=res.retrieved_at, section_hint=page.get("section_hint", "general"),
        )
        report.bump("pages_extracted")
        for link in discover_document_links(html, page["url"]):
            pdf_candidates.append((link.url, link.label, None))
    for extra in opts.sources.extra_pdfs:
        pdf_candidates.append((extra["url"], extra.get("title", "Linked document"), extra.get("service_id")))

    # ---------------------------------------------------------------- 4. PDFs
    by_id = {s["service_id"]: s for s in services}
    if not opts.skip_pdfs:
        urls, dropped = dedupe_by_canonical_url([c[0] for c in pdf_candidates])
        report.duplicates["service_urls"] += []  # (page duplicates already reported)
        lookup = {canonical_url(u): (u, l, s) for u, l, s in reversed(pdf_candidates)}
        report.totals["pdfs_discovered"] = len(urls)
        hashes: list[tuple[str, str]] = []
        for url in urls[: opts.policy.max_pdfs_per_run]:
            _, label, svc_id = lookup[canonical_url(url)]
            if not _pdf_allowed(fetcher, url):
                report.fail(url, "pdf", "blocked: host is not an approved official source")
                report.bump("pdfs_failed")
                continue
            res = fetcher.fetch(url, pdf=True, stage="pdf")
            if not res.ok:
                report.fail(url, "pdf", res.error or "unknown")
                report.bump("pdfs_failed")
                continue
            registry.record(url, res.sha256 or "", res.retrieved_at, res.etag, res.last_modified, "pdf")
            snapshots.append((res.sha256 or "", "pdf"))
            hashes.append((url, res.sha256 or ""))
            _ingest_pdf(res.content, url, label, svc_id, res.retrieved_at, res.sha256 or "", "pdf", opts, report, by_id, general_chunks, extra_sources)
        report.duplicates["pdf_content"] = list(find_duplicate_content([(u, h) for u, h in hashes]).values())

    # ---------------------------------------------------------------- 5. administrator input
    for meta, pdf in admin.uploads:
        report.bump("admin_uploads")
        url = meta["origin"] if str(meta["origin"]).startswith("https://") else f"https://upload.invalid/{meta['sha256']}"
        _ingest_pdf(pdf, url, meta["title"], meta.get("service_id"), meta["uploaded_at"], meta["sha256"], "admin_upload", opts, report, by_id,
                    general_chunks, extra_sources, department=meta.get("department"))
    for sid, override in admin.overrides.items():
        if sid in by_id:
            by_id[sid].setdefault("_manual_chunks", []).extend(apply_override(by_id[sid], override))
    for sid, svc in by_id.items():
        apply_review(svc, admin.decisions.get(sid))

    # ---------------------------------------------------------------- 6. duplicates, removed, release
    report.duplicates["service_content"] = list(find_duplicate_content([(s["service_id"], s["content_hash"]) for s in services]).values())
    for ids in report.duplicates["service_content"]:
        for sid in ids[1:]:
            by_id[sid]["extraction_warnings"].append(f"identical content to {ids[0]}")
    report.removed = registry.missing_this_run("service")
    report.totals["services_removed"] = len(report.removed)
    report.totals["http_requests"] = fetcher.request_count

    manifest = build_release(opts.output, services=services, extra_chunks=general_chunks, extra_sources=extra_sources, release_id=release_id,
                             report=report.finish(), embedding_provider=opts.embedding_provider)
    validation = validate_and_record(opts.output)
    manifest["validation_status"] = "passed" if validation.passed else "failed"
    if not validation.passed:
        report.notes.append(f"validation failed with {len(validation.errors)} error(s)")
    return PipelineResult(report=report.to_dict(), manifest=manifest, validation_passed=validation.passed, registry=registry, snapshots=snapshots)


def _abs(url: str, base: str) -> str:
    from urllib.parse import urljoin
    return urljoin(base, url)


def _source(sid, url, title, publisher, doc_type, retrieved_at, sha, method, published=None, modified=None, page=None) -> dict:
    return {"source_id": sid, "source_url": url, "title": title, "publisher_or_department": publisher, "document_type": doc_type,
            "retrieved_at": retrieved_at, "published_at": published, "last_modified_at": modified, "content_hash": sha,
            "page_or_section": page, "extraction_method": method}


def _ingest_pdf(data, url, label, service_id, retrieved_at, sha, kind, opts, report, by_id, general_chunks, extra_sources, department=None):
    """Extracts one PDF and turns its pages into chunks (and a source record)."""
    result = extract_pdf(data, ocr=opts.ocr)
    entry = {"url": url, "label": label, "sha256": sha, "pages": result.page_count, "ocr_pages": result.ocr_pages,
             "needs_review": result.needs_review, "warnings": result.warnings[:10], "service_id": service_id, "kind": kind}
    report.pdfs.append(entry)
    if not result.pages:
        report.fail(url, "pdf-extract", "; ".join(result.warnings) or "no text extracted")
        report.bump("pdfs_failed")
        return
    report.bump("pdfs_extracted")
    if result.ocr_pages:
        report.bump("pdfs_ocr")
    if result.needs_review:
        report.bump("pdfs_needing_review")
    title = normalize_text(label if label and label.lower() != "download" else (result.title or "Linked document"))
    sid = source_id_for(url if kind == "pdf" else sha)
    extra_sources.append(_source(sid, url if url.startswith("https://") and "upload.invalid" not in url else f"https://sewasetu.invalid/uploaded/{sha[:16]}", title,
                                department or "Sewa Setu", "admin_upload" if kind == "admin_upload" else "pdf", retrieved_at, sha,
                                result.method, result.created_at, result.modified_at))
    # Pages with poor OCR are withheld from the searchable corpus (reported for human review).
    usable = [p for p in result.pages if not (p.method == "ocr" and (p.quality or 0) < 0.55)]
    blocks = [(f"{title} - page {p.number}", p.text, f"p. {p.number}" + (" (OCR)" if p.method == "ocr" else "")) for p in usable]
    src_url = extra_sources[-1]["source_url"]
    if service_id and service_id in by_id:
        svc = by_id[service_id]
        svc["sources"].append({**extra_sources[-1], "page_or_section": f"{result.page_count} pages"})
        chunks = chunk_text_blocks(blocks, chunk_prefix=service_id, id_tag=f"pdf{sid[4:12]}-", source_url=src_url, source_title=title,
                                   retrieved_at=retrieved_at, service_id=service_id,
                                   department_id=svc["department"]["department_id"] if svc["department"] else None)
    else:
        chunks = chunk_text_blocks(blocks, chunk_prefix=f"general~{sid}", source_url=src_url, source_title=title, retrieved_at=retrieved_at)
    general_chunks.extend(chunks)


class _PreviousRelease:
    """Reads service records of the currently active release (for carry-forward on fetch failure)."""

    def __init__(self, store: ObjectStore | None):
        self.store, self.prefix = store, None
        if store:
            raw = store.get("current.json")
            if raw:
                self.prefix = f"releases/{json.loads(raw)['release_id']}/"

    def service(self, service_id: str) -> dict | None:
        if not (self.store and self.prefix):
            return None
        raw = self.store.get(f"{self.prefix}catalog/services/{service_id}.json")
        return json.loads(raw) if raw else None
