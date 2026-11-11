"""Crawler policy: allow-list, robots, throttling, retries/backoff, redirects, conditional requests, CAPTCHA, size limits."""
import requests

from conftest import FakeResponse, FakeSession
from sewasetu_ingest.crawler.http import PoliteFetcher

H = "https://test.example.gov.in"
ROBOTS_OK = FakeResponse(404, b"<html>404</html>", {"content-type": "text/html"})


def fetcher(sources, policy, routes, **kw):
    sleeps, clock = [], [0.0]
    f = PoliteFetcher(sources, policy, session=FakeSession({f"{H}/robots.txt": ROBOTS_OK, **routes}), sleep=lambda s: (sleeps.append(s), clock.__setitem__(0, clock[0] + s)), clock=lambda: clock[0], **kw)
    return f, sleeps


def test_fetches_allowed_page_and_hashes_content(sources, policy):
    f, _ = fetcher(sources, policy, {f"{H}/a": FakeResponse(200, b"<html>ok</html>", {"content-type": "text/html", "etag": '"e1"'})})
    r = f.fetch(f"{H}/a")
    assert r.ok and r.etag == '"e1"' and len(r.sha256) == 64
    assert f.session.headers["User-Agent"].startswith("TestAgent")


def test_refuses_unapproved_hosts_and_non_https(sources, policy):
    f, _ = fetcher(sources, policy, {})
    for url in ("https://evil.example.com/x", "http://test.example.gov.in/x", "ftp://test.example.gov.in/x"):
        r = f.fetch(url)
        assert not r.ok and "approved" in r.error
    assert f.session.calls == []  # nothing was requested
    assert len(f.failures) == 3


def test_pdf_hosts_are_allowed_by_suffix_only_for_pdfs(sources, policy):
    f, _ = fetcher(sources, policy, {})
    assert f.is_allowed_host("https://dept.example.gov.in/g.pdf", pdf=True)
    assert not f.is_allowed_host("https://dept.example.gov.in/page", pdf=False)
    assert not f.is_allowed_host("https://dept.other.org/g.pdf", pdf=True)


def test_robots_disallow_is_honoured(sources, policy):
    robots = FakeResponse(200, b"User-agent: *\nDisallow: /private/", {"content-type": "text/plain"})
    f, _ = fetcher(sources, policy, {f"{H}/robots.txt": robots, f"{H}/private/x": FakeResponse(200, b"secret"), f"{H}/public": FakeResponse(200, b"hi")})
    assert "robots" in f.fetch(f"{H}/private/x").error
    assert f.fetch(f"{H}/public").ok


def test_robots_server_error_means_disallow_all(sources, policy):
    f, _ = fetcher(sources, policy, {f"{H}/robots.txt": FakeResponse(503, b""), f"{H}/a": FakeResponse(200, b"x")})
    assert "robots" in f.fetch(f"{H}/a").error


def test_per_host_throttling_delays_consecutive_requests(sources, policy):
    from sewasetu_ingest.config import CrawlPolicy
    pol = CrawlPolicy(**{**policy.__dict__, "delay_seconds": 2.0})
    f, sleeps = fetcher(sources, pol, {f"{H}/a": FakeResponse(200, b"a"), f"{H}/b": FakeResponse(200, b"b")})
    f.fetch(f"{H}/a"); f.fetch(f"{H}/b")
    assert any(s >= 1.99 for s in sleeps)


def test_transient_errors_are_retried_with_exponential_backoff(sources, policy):
    f, sleeps = fetcher(sources, policy, {f"{H}/a": [FakeResponse(500), requests.ConnectionError("x"), FakeResponse(200, b"finally")]})
    r = f.fetch(f"{H}/a")
    assert r.ok and r.content == b"finally"
    assert [s for s in sleeps if s >= 1] == [1.0, 2.0]


def test_gives_up_after_max_retries_and_records_failure(sources, policy):
    f, _ = fetcher(sources, policy, {f"{H}/a": FakeResponse(500)})
    r = f.fetch(f"{H}/a")
    assert not r.ok and "500" in r.error
    assert f.failures[0].url == f"{H}/a" and f.failures[0].stage == "fetch"


def test_does_not_retry_client_errors_and_never_bypasses_access_controls(sources, policy):
    f, _ = fetcher(sources, policy, {f"{H}/missing": FakeResponse(404), f"{H}/locked": FakeResponse(403)})
    assert "404" in f.fetch(f"{H}/missing").error
    assert "not bypassed" in f.fetch(f"{H}/locked").error
    assert len([c for c in f.session.calls if c[0].endswith("/missing")]) == 1


def test_captcha_challenge_pages_are_reported_not_solved(sources, policy):
    f, _ = fetcher(sources, policy, {f"{H}/a": FakeResponse(200, b"<html>Please complete the CAPTCHA to continue</html>")})
    assert "CAPTCHA" in f.fetch(f"{H}/a").error


def test_long_retry_after_is_not_waited_out(sources, policy):
    f, sleeps = fetcher(sources, policy, {f"{H}/a": FakeResponse(429, b"", {"retry-after": "3600"})})
    assert "back off" in f.fetch(f"{H}/a").error
    assert max(sleeps or [0]) < 100


def test_redirects_are_followed_but_each_hop_is_checked(sources, policy):
    ok = {f"{H}/old": FakeResponse(301, b"", {"location": "/new"}), f"{H}/new": FakeResponse(200, b"moved")}
    f, _ = fetcher(sources, policy, ok)
    r = f.fetch(f"{H}/old")
    assert r.ok and r.final_url == f"{H}/new" and r.redirects == [f"{H}/new"]
    bad = {f"{H}/old": FakeResponse(302, b"", {"location": "https://evil.example.com/x"})}
    f2, _ = fetcher(sources, policy, bad)
    assert "unapproved host" in f2.fetch(f"{H}/old").error


def test_size_limits_and_pdf_magic_bytes(sources, policy):
    from sewasetu_ingest.config import CrawlPolicy
    pol = CrawlPolicy(**{**policy.__dict__, "max_html_bytes": 100})
    f, _ = fetcher(sources, pol, {f"{H}/big": FakeResponse(200, b"x" * 500), f"{H}/f.pdf": FakeResponse(200, b"<html>not a pdf</html>")})
    assert "size limit" in f.fetch(f"{H}/big").error
    assert "not a PDF" in f.fetch(f"{H}/f.pdf", pdf=True).error


def test_conditional_request_reuses_cached_body_on_304(sources, policy, tmp_path):
    body = b"<html>cached</html>"
    first, _ = fetcher(sources, policy, {f"{H}/a": FakeResponse(200, body, {"etag": '"v1"'})}, cache_dir=tmp_path)
    r1 = first.fetch(f"{H}/a")
    validators = {f"{H}/a": {"etag": r1.etag, "last_modified": None, "sha256": r1.sha256}}
    second, _ = fetcher(sources, policy, {f"{H}/a": FakeResponse(304)}, cache_dir=tmp_path, validators=validators)
    r2 = second.fetch(f"{H}/a")
    assert r2.ok and r2.not_modified and r2.content == body
    assert second.session.calls[-1][1].get("If-None-Match") == '"v1"'
    # Without a cached body no conditional header is sent (we could not reuse a 304).
    third, _ = fetcher(sources, policy, {f"{H}/a": FakeResponse(200, body)}, cache_dir=tmp_path / "empty", validators=validators)
    third.fetch(f"{H}/a")
    assert "If-None-Match" not in third.session.calls[-1][1]
