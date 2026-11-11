"""Source discovery: turns directory/guideline pages into lists of services and documents.

The Sewa Setu directory pages are HTML tables ``Department | Service | Apply``;
each Apply link points at a ``/site/service-apply/<slug>`` page (the service detail
page we extract). Document pages link PDFs either directly (``*.pdf``) or through
the portal's ``/site/docs_download?p=...`` endpoint.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from ..util import canonical_url, normalize_text

SERVICE_PATH_RE = re.compile(r"/site/service-apply/([^/?#]+)")
DOC_LINK_RE = re.compile(r"(\.pdf(\?|$)|/docs_download\?)", re.I)


@dataclass(frozen=True)
class ServiceRef:
    url: str
    slug: str
    name: str
    department: str | None
    category: str


@dataclass(frozen=True)
class DocLink:
    url: str
    label: str
    found_on: str


def parse_directory(html: str, base_url: str, category: str) -> list[ServiceRef]:
    """Extracts service references from one directory page.

    Rows are read as (department, service name, link). Rows without a service link
    are ignored. Output order follows the page; duplicates within a page are removed.
    """
    soup = BeautifulSoup(html, "lxml")
    refs: dict[str, ServiceRef] = {}
    for a in soup.find_all("a", href=SERVICE_PATH_RE):
        url = canonical_url(urljoin(base_url, a["href"]))
        slug = SERVICE_PATH_RE.search(url).group(1)  # type: ignore[union-attr]
        row = a.find_parent("tr")
        cells = [normalize_text(td.get_text(" ", strip=True)) for td in row.find_all("td")] if row else []
        # Expected layout: [department, service, apply-button]; tolerate extra columns.
        name = cells[1] if len(cells) >= 2 else normalize_text(a.get_text(" ", strip=True))
        department = cells[0] if len(cells) >= 2 and cells[0] else None
        if url not in refs and name:
            refs[url] = ServiceRef(url=url, slug=slug, name=name, department=department, category=category)
    return list(refs.values())


def merge_refs(groups: list[list[ServiceRef]]) -> tuple[list[ServiceRef], list[ServiceRef]]:
    """Merges directory results. The first occurrence wins; later ones are returned as duplicates."""
    merged: dict[str, ServiceRef] = {}
    dupes: list[ServiceRef] = []
    for refs in groups:
        for r in refs:
            if r.url in merged:
                dupes.append(r)
            else:
                merged[r.url] = r
    return list(merged.values()), dupes


def discover_document_links(html: str, base_url: str) -> list[DocLink]:
    """Finds linked PDF/download links on a guideline page, with a human label when available."""
    soup = BeautifulSoup(html, "lxml")
    seen: dict[str, DocLink] = {}
    for a in soup.find_all("a", href=True):
        if not DOC_LINK_RE.search(a["href"]):
            continue
        url = urljoin(base_url, a["href"])
        if urlsplit(url).scheme != "https":
            continue
        # Label: the list item/table row text that precedes the "download" button.
        holder = a.find_parent("li") or a.find_parent("tr")
        if holder is not None:
            clone_text = holder.get_text(" ", strip=True).replace(a.get_text(" ", strip=True), "", 1)
            label_src = holder.find("td").get_text(" ", strip=True) if holder.name == "tr" and holder.find("td") else clone_text
        else:
            label_src = a.get_text(" ", strip=True)
        label = normalize_text(label_src) or "Linked document"
        seen.setdefault(url, DocLink(url=url, label=label[:300], found_on=base_url))
    return list(seen.values())
