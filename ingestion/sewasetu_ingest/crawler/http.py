"""Respectful HTTP fetcher.

Policy implemented here (spec section 8.1):
  * only allow-listed hosts (HTML) / allow-listed suffixes over https (PDF);
  * robots.txt honoured (RFC 9309 semantics: 4xx => no restrictions, 5xx => disallow);
  * per-host throttling, timeouts, bounded retries with exponential backoff;
  * conditional requests (ETag / Last-Modified) when a cached body exists;
  * redirects are followed manually so every hop is re-checked against the allow-list;
  * CAPTCHA / access-control responses are reported as failures - never bypassed.

Every failure is *recorded* (see ``failures``) and the crawl continues, so a
broken source can never silently disappear from the ingestion report.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib import robotparser
from urllib.parse import urljoin, urlsplit

import requests

from ..config import CrawlPolicy, Sources
from ..util import sha256_hex, utc_now_iso

REDIRECT_CODES = {301, 302, 303, 307, 308}
CAPTCHA_RE = re.compile(r"(captcha|are you a robot|access denied|cf-chl|attention required)", re.I)


@dataclass
class FetchResult:
    """Outcome of one fetch. ``content`` is None for errors and for 304 without a cached body."""

    url: str
    final_url: str
    status: int | None
    content: bytes | None
    content_type: str | None
    etag: str | None
    last_modified: str | None
    sha256: str | None
    retrieved_at: str
    not_modified: bool = False
    error: str | None = None
    redirects: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.error is None and self.content is not None


@dataclass
class Failure:
    url: str
    stage: str
    error: str
    at: str = field(default_factory=utc_now_iso)


class PoliteFetcher:
    """Fetches allow-listed URLs politely. Inject ``session``/``sleep``/``clock`` in tests."""

    def __init__(
        self,
        sources: Sources,
        policy: CrawlPolicy,
        session: requests.Session | None = None,
        sleep=time.sleep,
        clock=time.monotonic,
        cache_dir: Path | None = None,
        validators: dict[str, dict] | None = None,
    ):
        self.sources = sources
        self.policy = policy
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = sources.user_agent
        self._sleep = sleep
        self._clock = clock
        self._last_request: dict[str, float] = {}
        self._robots: dict[str, robotparser.RobotFileParser | None] = {}
        self.cache_dir = cache_dir
        # url -> {"etag":..., "last_modified":..., "sha256":...} from the previous run's source registry.
        self.validators = validators or {}
        self.failures: list[Failure] = []
        self.request_count = 0

    # ------------------------------------------------------------------ policy checks
    def is_allowed_host(self, url: str, pdf: bool = False) -> bool:
        parts = urlsplit(url)
        if parts.scheme != "https" or not parts.hostname:
            return False
        host = parts.hostname.lower()
        if host in self.sources.allowed_hosts:
            return True
        return pdf and any(host.endswith(s) for s in self.sources.allowed_pdf_host_suffixes)

    def _robots_allows(self, url: str) -> bool:
        if not self.policy.respect_robots_txt:
            return True
        host = urlsplit(url).netloc.lower()
        if host not in self._robots:
            rp = robotparser.RobotFileParser()
            try:
                self._throttle(host)
                res = self.session.get(f"https://{host}/robots.txt", timeout=self.policy.timeout_seconds, allow_redirects=False)
                self.request_count += 1
                if res.status_code == 200 and "html" not in res.headers.get("content-type", "").lower():
                    rp.parse(res.text.splitlines())
                    self._robots[host] = rp
                elif 400 <= res.status_code < 500:
                    self._robots[host] = None  # no robots.txt => no restrictions (RFC 9309)
                elif res.status_code >= 500:
                    rp.parse(["User-agent: *", "Disallow: /"])  # server error => assume disallowed
                    self._robots[host] = rp
                else:
                    self._robots[host] = None
            except requests.RequestException:
                rp.parse(["User-agent: *", "Disallow: /"])
                self._robots[host] = rp
        rp = self._robots[host]
        return True if rp is None else rp.can_fetch(self.sources.user_agent, url)

    def _throttle(self, host: str) -> None:
        """Sleeps so that two requests to one host are at least ``delay_seconds`` apart."""
        last = self._last_request.get(host)
        if last is not None:
            wait = self.policy.delay_seconds - (self._clock() - last)
            if wait > 0:
                self._sleep(wait)
        self._last_request[host] = self._clock()

    # ------------------------------------------------------------------ fetching
    def _cache_path(self, sha: str) -> Path | None:
        return self.cache_dir / sha if self.cache_dir else None

    def _cached_body(self, url: str) -> bytes | None:
        v = self.validators.get(url)
        p = self._cache_path(v["sha256"]) if v and v.get("sha256") else None
        return p.read_bytes() if p and p.exists() else None

    def store_cache(self, sha: str, body: bytes) -> None:
        p = self._cache_path(sha)
        if p:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)

    def fetch(self, url: str, *, pdf: bool = False, stage: str = "fetch") -> FetchResult:
        """Fetches one URL; never raises - failures are returned and recorded."""
        result = self._fetch(url, pdf=pdf)
        if result.error:
            self.failures.append(Failure(url=url, stage=stage, error=result.error))
        elif result.content is not None and not result.not_modified:
            self.store_cache(result.sha256 or "", result.content)
        return result

    def _error(self, url: str, msg: str, status: int | None = None, redirects: list[str] | None = None) -> FetchResult:
        return FetchResult(url, url, status, None, None, None, None, None, utc_now_iso(), error=msg, redirects=redirects or [])

    def _fetch(self, url: str, *, pdf: bool) -> FetchResult:
        if not self.is_allowed_host(url, pdf):
            return self._error(url, "blocked: host is not on the approved source list")
        if not self._robots_allows(url):
            return self._error(url, "blocked: disallowed by robots.txt")

        max_bytes = self.policy.max_pdf_bytes if pdf else self.policy.max_html_bytes
        headers: dict[str, str] = {}
        cached = self._cached_body(url)
        v = self.validators.get(url)
        if cached is not None and v:  # conditional request only when we can actually reuse a cached body
            if v.get("etag"):
                headers["If-None-Match"] = v["etag"]
            if v.get("last_modified"):
                headers["If-Modified-Since"] = v["last_modified"]

        current, redirects = url, []
        for attempt in range(self.policy.max_retries + 1):
            try:
                self._throttle(urlsplit(current).netloc.lower())
                self.request_count += 1
                res = self.session.get(current, headers=headers, timeout=self.policy.timeout_seconds, allow_redirects=False, stream=True)
            except requests.RequestException as exc:
                if attempt == self.policy.max_retries:
                    return self._error(url, f"network error after {attempt + 1} attempts: {type(exc).__name__}", redirects=redirects)
                self._sleep(self.policy.backoff_base_seconds * 2**attempt)
                continue

            status = res.status_code
            if status in REDIRECT_CODES and res.headers.get("location"):
                nxt = urljoin(current, res.headers["location"])
                if len(redirects) >= 5:
                    return self._error(url, "too many redirects", status, redirects)
                if not self.is_allowed_host(nxt, pdf):  # re-check every hop
                    return self._error(url, f"blocked: redirect to unapproved host {urlsplit(nxt).hostname}", status, redirects)
                redirects.append(nxt)
                current = nxt
                res.close()
                continue
            if status == 304 and cached is not None:
                return FetchResult(url, current, 304, cached, None, v.get("etag") if v else None, v.get("last_modified") if v else None,
                                   sha256_hex(cached), utc_now_iso(), not_modified=True, redirects=redirects)
            if status == 429 or status == 503:
                retry_after = res.headers.get("retry-after", "")
                wait = float(retry_after) if retry_after.isdigit() else self.policy.backoff_base_seconds * 2**attempt
                res.close()
                if wait > self.policy.max_retry_after_seconds or attempt == self.policy.max_retries:
                    return self._error(url, f"server asked us to back off (HTTP {status}); giving up", status, redirects)
                self._sleep(wait)
                continue
            if status >= 500 or status == 408:
                res.close()
                if attempt == self.policy.max_retries:
                    return self._error(url, f"server error HTTP {status} after {attempt + 1} attempts", status, redirects)
                self._sleep(self.policy.backoff_base_seconds * 2**attempt)
                continue
            if status in (401, 403):
                res.close()
                return self._error(url, f"access restricted (HTTP {status}); not bypassed", status, redirects)
            if status >= 400:
                res.close()
                return self._error(url, f"HTTP {status}", status, redirects)

            body = b""
            for chunk in res.iter_content(65536):
                body += chunk
                if len(body) > max_bytes:
                    res.close()
                    return self._error(url, f"response exceeds size limit ({max_bytes} bytes)", status, redirects)
            ctype = res.headers.get("content-type", "")
            if not pdf and CAPTCHA_RE.search(body[:4000].decode("utf-8", "ignore")) and len(body) < 20000:
                return self._error(url, "page looks like a CAPTCHA/access-control challenge; not bypassed", status, redirects)
            if pdf and not body.startswith(b"%PDF"):
                return self._error(url, "response is not a PDF", status, redirects)
            return FetchResult(url, current, status, body, ctype, res.headers.get("etag"), res.headers.get("last-modified"),
                               sha256_hex(body), utc_now_iso(), redirects=redirects)
        return self._error(url, "retries exhausted")
