"""End-to-end pipeline tests with an offline fake fetcher serving the synthetic fixtures."""
import json

import pytest

from conftest import fx
from sewasetu_ingest.crawler.http import FetchResult, Failure
from sewasetu_ingest.pipeline import PipelineError, PipelineOptions, run_pipeline
from sewasetu_ingest.publisher.store import LocalDirObjectStore
from sewasetu_ingest.util import sha256_hex
from test_pdf import LONG, make_text_pdf

H = "https://test.example.gov.in"


class FakeFetcher:
    """Serves fixtures from a dict; raises nothing. Mirrors the PoliteFetcher surface used by the pipeline."""

    def __init__(self, pages: dict[str, bytes | None], validators=None):
        self.pages, self.failures, self.request_count, self.validators = pages, [], 0, validators or {}

    def is_allowed_host(self, url, pdf=False):
        return url.startswith("https://test.example.gov.in") or (pdf and ".example.gov.in" in url)

    def fetch(self, url, *, pdf=False, stage="fetch"):
        self.request_count += 1
        body = self.pages.get(url)
        if body is None:
            self.failures.append(Failure(url, stage, "HTTP 500"))
            return FetchResult(url, url, 500, None, None, None, None, None, "2026-11-11T10:00:00Z", error="HTTP 500")
        return FetchResult(url, url, 200, body, "text/html", None, None, sha256_hex(body), "2026-11-11T10:00:00Z")


def pages(**over):
    base = {
        f"{H}/site/online/citizen": fx("directory-citizen.html").encode(),
        f"{H}/site/online/schemes": fx("directory-schemes.html").encode(),
        f"{H}/site/service-apply/test-income-certificate": fx("service-income.html").encode(),
        f"{H}/site/service-apply/test-trade-licence": fx("service-trade.html").encode(),
        f"{H}/site/service-apply/test-scholarship": fx("service-scholarship.html").encode(),
        f"{H}/site/appeal-raise": fx("appeal-page.html").encode(),
        f"{H}/files/appeal-manual.pdf": make_text_pdf(["Appeal manual page one. " + LONG, "Appeal manual page two. Appeals must be filed within the stated period."]),
        f"{H}/files/guideline.pdf": make_text_pdf(["Income certificate guideline. " + LONG]),
        f"{H}/site/docs_download?p=abc123": make_text_pdf(["Acts and rules. " + LONG]),
    }
    base.update(over)
    return base


def run(tmp_path, sources, policy, pg, **kw):
    opts = PipelineOptions(output=tmp_path / "rel", sources=sources, policy=policy, release_id="2026-11-11T100000Z-aaaaaa", **kw)
    return run_pipeline(opts, FakeFetcher(pg)), tmp_path / "rel"


def test_full_run_builds_a_valid_release(tmp_path, sources, policy):
    res, out = run(tmp_path, sources, policy, pages())
    assert res.validation_passed, json.loads((out / "reports/validation-report.json").read_text())["errors"]
    m = res.manifest
    assert (m["service_count"], m["verified_service_count"]) == (3, 0)  # nothing is verified by extraction
    assert m["chunk_count"] > 8 and m["retrieval"]["embedding_index"] is None
    t = res.report["totals"]
    assert t["services_discovered"] == 3 and t["services_extracted"] == 3 and t["pdfs_extracted"] == 3
    summaries = json.loads((out / "catalog/summaries.json").read_text())
    assert all(s["publication_status"] == "draft" for s in summaries)
    income = json.loads((out / "catalog/services/test-income-certificate.json").read_text())
    assert any(s["document_type"] == "pdf" for s in income["sources"])  # linked guideline PDF attached to its service
    chunks = [c for f in sorted((out / "chunks").glob("*.json")) for c in json.loads(f.read_text())]
    assert any(c["chunk_id"].startswith("general~") and c["section_type"] == "appeal" for c in chunks)
    assert any(c["source_url"].endswith("appeal-manual.pdf") and c["page_or_section"] == "p. 2" for c in chunks)  # PDF page attribution


def test_reports_unavailable_fields_and_duplicates(tmp_path, sources, policy):
    res, _ = run(tmp_path, sources, policy, pages())
    assert res.report["unavailable_fields"]["fees"] == 2  # trade licence + scholarship publish no fees
    assert res.report["duplicates"]["service_urls"]  # duplicate directory entries reported
    same = pages()
    same[f"{H}/files/guideline.pdf"] = same[f"{H}/files/appeal-manual.pdf"]  # identical bytes under two URLs
    res2, _ = run(tmp_path / "b", sources, policy, same)
    assert res2.report["duplicates"]["pdf_content"]


def test_failed_pages_are_reported_and_other_sources_continue(tmp_path, sources, policy):
    pg = pages()
    del pg[f"{H}/site/service-apply/test-scholarship"]
    res, _ = run(tmp_path, sources, policy, pg, max_failure_ratio=0.5)
    assert res.manifest["service_count"] == 2
    assert {"url": f"{H}/site/service-apply/test-scholarship", "stage": "service-page", "error": "HTTP 500"} in res.report["failures"]
    assert res.report["totals"]["services_failed"] == 1


def test_failure_ratio_gate_stops_a_broken_release(tmp_path, sources, policy):
    pg = pages()
    for slug in ("test-scholarship", "test-trade-licence"):
        del pg[f"{H}/site/service-apply/{slug}"]
    with pytest.raises(PipelineError, match="above the allowed ratio"):
        run(tmp_path, sources, policy, pg)


def test_unreachable_directories_abort(tmp_path, sources, policy):
    with pytest.raises(PipelineError, match="no service directory"):
        run(tmp_path, sources, policy, {})


def test_bad_pdf_is_reported_without_breaking_the_run(tmp_path, sources, policy):
    pg = pages(**{f"{H}/files/guideline.pdf": b"%PDF-1.4 garbage"})
    res, _ = run(tmp_path, sources, policy, pg)
    assert res.validation_passed
    assert any(f["stage"] == "pdf-extract" for f in res.report["failures"])
    assert res.report["totals"]["pdfs_failed"] == 1


def test_carry_forward_keeps_a_published_service_when_its_page_fails(tmp_path, sources, policy):
    store = LocalDirObjectStore(tmp_path / "store")
    res, out = run(tmp_path / "first", sources, policy, pages())
    from sewasetu_ingest.publisher.release import publish_release
    publish_release(out, store)
    pg = pages()
    del pg[f"{H}/site/service-apply/test-income-certificate"]
    res2, out2 = run(tmp_path / "second", sources, policy, pg, store=store, max_failure_ratio=0.5)
    assert res2.manifest["service_count"] == 3  # not dropped
    svc = json.loads((out2 / "catalog/services/test-income-certificate.json").read_text())
    assert any("carried forward" in w for w in svc["extraction_warnings"])
    assert "carried forward test-income-certificate" in res2.report["notes"]


def test_change_detection_between_runs(tmp_path, sources, policy):
    from sewasetu_ingest.registry import SourceRegistry
    res1, _ = run(tmp_path / "a", sources, policy, pages())
    reg = res1.registry
    assert res1.report["totals"]["services_new"] == 3
    changed = pages(**{f"{H}/site/service-apply/test-trade-licence": fx("service-trade.html").replace("15 working days", "20 working days").encode()})
    opts = PipelineOptions(output=tmp_path / "b", sources=sources, policy=policy, release_id="2026-11-12T100000Z-bbbbbb")
    import sewasetu_ingest.pipeline as pl
    orig = SourceRegistry.load
    SourceRegistry.load = classmethod(lambda cls, store: reg)  # reuse the registry from run 1
    try:
        res2 = pl.run_pipeline(opts, FakeFetcher(changed))
    finally:
        SourceRegistry.load = orig
    t = res2.report["totals"]
    assert (t["services_changed"], t["services_unchanged"], t["services_new"]) == (1, 2, 0)


def test_admin_upload_override_and_review_are_applied(tmp_path, sources, policy):
    store = LocalDirObjectStore(tmp_path / "store")
    first, out = run(tmp_path / "first", sources, policy, pages())
    svc = json.loads((out / "catalog/services/test-income-certificate.json").read_text())
    pdf = make_text_pdf(["Officially obtained circular on fees. " + LONG])
    sha = sha256_hex(pdf)
    store.put(f"admin/uploads/{sha}.pdf", pdf, "application/pdf")
    store.put("admin/uploads/index.json", json.dumps([{"upload_id": sha[:16], "sha256": sha, "filename": "c.pdf", "title": "Circular on fees", "department": "TEST FIXTURE Revenue Department",
                                                       "origin": "https://dept.example.gov.in/circular.pdf", "service_id": "test-income-certificate", "size": len(pdf), "uploaded_by": "admin", "uploaded_at": "2026-11-11T09:00:00Z"}]).encode())
    store.put("admin/overrides/test-trade-licence.json", json.dumps({
        "service_id": "test-trade-licence", "updated_by": "admin", "updated_at": "2026-11-11T09:00:00Z",
        "evidence": {"source_url": "https://dept.example.gov.in/rules.pdf", "note": "Rule 5 states the authority"},
        "patch": {"designated_authority": "Circle Officer", "eligibility": ["Applicant must hold a shop"]}}).encode())
    store.put("admin/review-state.json", json.dumps({"version": 1, "updated_at": "2026-11-11T09:00:00Z", "decisions": {
        "test-income-certificate": {"decision": "approved", "content_hash": svc["content_hash"], "reviewer": "admin", "reviewed_at": "2026-11-11T09:30:00Z", "notes": None},
        "test-scholarship": {"decision": "approved", "content_hash": "stale-hash-from-old-content", "reviewer": "admin", "reviewed_at": "2026-11-11T09:30:00Z", "notes": None},
        "test-trade-licence": {"decision": "rejected", "content_hash": "x", "reviewer": "admin", "reviewed_at": "2026-11-11T09:30:00Z", "notes": "bad"}}}).encode())
    res, out2 = run(tmp_path / "second", sources, policy, pages(), store=store)
    assert res.validation_passed, json.loads((out2 / "reports/validation-report.json").read_text())["errors"]
    by = {s["service_id"]: s for s in json.loads((out2 / "catalog/summaries.json").read_text())}
    assert by["test-income-certificate"]["publication_status"] == "verified"
    assert by["test-scholarship"]["publication_status"] == "draft"  # stale approval ignored
    assert by["test-trade-licence"]["publication_status"] == "rejected"
    trade = json.loads((out2 / "catalog/services/test-trade-licence.json").read_text())
    assert trade["designated_authority"] == "Circle Officer"
    assert trade["eligibility"][0]["source_chunk_id"].endswith("#eligibility#m0")
    assert any(s["extraction_method"] == "manual" for s in trade["sources"])
    income = json.loads((out2 / "catalog/services/test-income-certificate.json").read_text())
    assert any(s["document_type"] == "admin_upload" for s in income["sources"])
    assert res.report["totals"]["admin_uploads"] == 1
