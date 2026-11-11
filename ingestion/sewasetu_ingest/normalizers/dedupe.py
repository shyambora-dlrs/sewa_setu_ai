"""Duplicate detection for services and downloaded documents."""
from __future__ import annotations

from collections import defaultdict

from ..util import canonical_url


def dedupe_by_canonical_url(urls: list[str]) -> tuple[list[str], list[str]]:
    """Returns (unique_urls_in_order, dropped_duplicates) by canonical URL."""
    seen: set[str] = set()
    unique, dropped = [], []
    for u in urls:
        c = canonical_url(u)
        if c in seen:
            dropped.append(u)
        else:
            seen.add(c)
            unique.append(u)
    return unique, dropped


def find_duplicate_content(items: list[tuple[str, str]]) -> dict[str, list[str]]:
    """Groups ids sharing an identical content hash. ``items`` is ``[(id, content_hash)]``.

    Used for PDFs (same bytes under different URLs) and services (identical content
    under different ids). Returns only groups with more than one member, keyed by hash.
    """
    groups: dict[str, list[str]] = defaultdict(list)
    for item_id, h in items:
        groups[h].append(item_id)
    return {h: ids for h, ids in groups.items() if len(ids) > 1}
