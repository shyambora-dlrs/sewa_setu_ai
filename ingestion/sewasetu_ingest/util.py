"""Small shared helpers (hashing, timestamps, slugs, text normalisation)."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit


def utc_now_iso() -> str:
    """Current UTC time as an ISO-8601 string ending in ``Z`` (matches the Zod schema)."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def canonical_json(obj) -> str:
    """Deterministic JSON used for content hashing (sorted keys, no whitespace, UTF-8)."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def canonical_url(url: str) -> str:
    """Normalises a URL for de-duplication: lower-case host, no fragment/query, no trailing slash."""
    parts = urlsplit(url.strip())
    path = re.sub(r"/{2,}", "/", parts.path).rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, "", ""))


def normalize_text(text: str) -> str:
    """Collapses whitespace and normalises Unicode (NFC) without altering meaning.

    Non-breaking spaces and zero-width characters (common in CMS output) are
    removed so identical text hashes identically across runs.
    """
    text = unicodedata.normalize("NFC", text)
    text = text.replace(" ", " ").replace("​", "").replace("﻿", "")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"[ \t]*\n[ \t\n]*", "\n", text)  # collapse blank lines and trim spaces around newlines
    return text.strip()


def slugify(text: str, max_len: int = 120) -> str:
    """ASCII slug used for service/department ids (``[a-z0-9-]``)."""
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text).strip("-")
    return text[:max_len].strip("-") or "item"
