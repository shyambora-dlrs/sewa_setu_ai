#!/usr/bin/env python3
"""Builds a tiny release from the SYNTHETIC html fixtures into tests/fixtures/py-release/.

The TypeScript test `tests/python-release-compat.test.ts` loads it through the Worker's real
R2 repository code, proving that the Python-built BM25 index/chunk layout is readable and
searchable by the TypeScript side. Regenerate with:  python3 ingestion/tests/make_fixture_release.py
"""
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from sewasetu_ingest.config import CrawlPolicy, Sources  # noqa: E402
from sewasetu_ingest.pipeline import PipelineOptions, run_pipeline  # noqa: E402
from test_pipeline import FakeFetcher, pages  # noqa: E402

OUT = HERE.parents[1] / "tests" / "fixtures" / "py-release"

sources = Sources(
    user_agent="fixture", allowed_hosts=("test.example.gov.in",), allowed_pdf_host_suffixes=(".example.gov.in",),
    directories=({"url": "https://test.example.gov.in/site/online/citizen", "category": "citizen"},
                 {"url": "https://test.example.gov.in/site/online/schemes", "category": "schemes"}),
    guideline_pages=({"url": "https://test.example.gov.in/site/appeal-raise", "title": "TEST FIXTURE appeal page", "section_hint": "appeal"},),
)
shutil.rmtree(OUT, ignore_errors=True)
res = run_pipeline(PipelineOptions(output=OUT, sources=sources, policy=CrawlPolicy(delay_seconds=0), release_id="2026-11-11T100000Z-pyfixt", skip_pdfs=True), FakeFetcher(pages()))
assert res.validation_passed
print(f"wrote {OUT} ({res.manifest['service_count']} services, {res.manifest['chunk_count']} chunks)")
