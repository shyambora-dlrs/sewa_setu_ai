"""Pytest setup: makes ``sewasetu_ingest`` importable and provides shared fixtures/fakes."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FIXTURES = Path(__file__).parent / "fixtures"


def fx(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None):
        self.status_code, self._body, self.headers = status, body, headers or {}
        self.text = body.decode("utf-8", "ignore")

    def iter_content(self, size):
        for i in range(0, len(self._body), size):
            yield self._body[i : i + size]

    def close(self):
        pass


class FakeSession:
    """Scripted ``requests.Session``: maps URL -> list of responses (consumed in order, last one repeats)."""

    def __init__(self, routes):
        self.routes = {k: (v if isinstance(v, list) else [v]) for k, v in routes.items()}
        self.headers = {}
        self.calls = []

    def get(self, url, headers=None, timeout=None, allow_redirects=True, stream=False):
        self.calls.append((url, dict(headers or {})))
        queue = self.routes.get(url)
        if queue is None:
            return FakeResponse(404, b"not found")
        r = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(r, Exception):
            raise r
        return r


@pytest.fixture
def sources():
    from sewasetu_ingest.config import Sources

    return Sources(
        user_agent="TestAgent/1.0 (+test)", allowed_hosts=("test.example.gov.in",), allowed_pdf_host_suffixes=(".example.gov.in",),
        directories=({"url": "https://test.example.gov.in/site/online/citizen", "category": "citizen"},
                     {"url": "https://test.example.gov.in/site/online/schemes", "category": "schemes"}),
        guideline_pages=({"url": "https://test.example.gov.in/site/appeal-raise", "title": "TEST FIXTURE appeal page", "section_hint": "appeal"},),
    )


@pytest.fixture
def policy():
    from sewasetu_ingest.config import CrawlPolicy

    return CrawlPolicy(delay_seconds=0.0, timeout_seconds=5, max_retries=2, backoff_base_seconds=1.0, max_retry_after_seconds=5.0)
