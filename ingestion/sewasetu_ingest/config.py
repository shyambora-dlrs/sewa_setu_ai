"""Loads and validates ``config/sources.yaml`` and ``config/crawl-policy.yaml``."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


@dataclass(frozen=True)
class CrawlPolicy:
    """Politeness and safety limits for every outgoing request."""

    delay_seconds: float = 1.0
    timeout_seconds: float = 30.0
    max_retries: int = 3
    backoff_base_seconds: float = 2.0
    max_retry_after_seconds: float = 30.0
    max_html_bytes: int = 3_000_000
    max_pdf_bytes: int = 30_000_000
    max_pdfs_per_run: int = 250
    respect_robots_txt: bool = True


@dataclass(frozen=True)
class Sources:
    user_agent: str
    allowed_hosts: tuple[str, ...]
    allowed_pdf_host_suffixes: tuple[str, ...]
    directories: tuple[dict, ...]
    guideline_pages: tuple[dict, ...]
    extra_pdfs: tuple[dict, ...] = field(default_factory=tuple)


def load_policy(path: Path | None = None) -> CrawlPolicy:
    raw = yaml.safe_load((path or CONFIG_DIR / "crawl-policy.yaml").read_text()) or {}
    known = CrawlPolicy.__dataclass_fields__
    unknown = set(raw) - set(known)
    if unknown:
        raise ValueError(f"Unknown crawl-policy keys: {sorted(unknown)}")
    return CrawlPolicy(**raw)


def load_sources(path: Path | None = None) -> Sources:
    raw = yaml.safe_load((path or CONFIG_DIR / "sources.yaml").read_text()) or {}
    for key in ("user_agent", "allowed_hosts", "directories"):
        if not raw.get(key):
            raise ValueError(f"sources.yaml is missing required key: {key}")
    for d in raw["directories"] + raw.get("guideline_pages", []):
        if not str(d.get("url", "")).startswith("https://"):
            raise ValueError(f"Source URL must use https: {d}")
    return Sources(
        user_agent=raw["user_agent"],
        allowed_hosts=tuple(h.lower() for h in raw["allowed_hosts"]),
        allowed_pdf_host_suffixes=tuple(s.lower() for s in raw.get("allowed_pdf_host_suffixes", [])),
        directories=tuple(raw["directories"]),
        guideline_pages=tuple(raw.get("guideline_pages", [])),
        extra_pdfs=tuple(raw.get("extra_pdfs") or []),
    )
