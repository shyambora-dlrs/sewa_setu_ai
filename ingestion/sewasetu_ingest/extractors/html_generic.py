"""Extracts readable guideline text (FAQ, appeal, policy pages) as heading-scoped sections."""
from __future__ import annotations

import re
from dataclasses import dataclass

from bs4 import BeautifulSoup

from ..util import normalize_text


@dataclass
class TextSection:
    heading: str
    text: str


def extract_sections(html: str, fallback_title: str) -> tuple[str, list[TextSection]]:
    """Returns ``(page_title, sections)`` from the page's ``<main>`` content.

    Navigation, scripts, forms and modals are removed first. Content is grouped under
    the nearest preceding heading (h1-h5) or, for FAQ-style pages, bold question lines.
    """
    soup = BeautifulSoup(html, "lxml")
    title = fallback_title
    main = soup.find("main") or soup.body or soup
    # Accordion buttons are NOT removed: FAQ questions live inside them.
    for tag in main(["script", "style", "nav", "footer", "header", "form", "noscript", "svg", "iframe"]):
        tag.decompose()
    for tag in main.select(".modal, .offcanvas, [aria-hidden='true']"):
        tag.decompose()
    h1 = main.find(["h1", "h2"])
    if h1 and normalize_text(h1.get_text(" ", strip=True)):
        title = normalize_text(h1.get_text(" ", strip=True))

    sections: list[TextSection] = []
    heading, buf = title, []

    def flush():
        text = normalize_text("\n".join(buf))
        if len(text) >= 20:
            sections.append(TextSection(heading=heading, text=text))
        buf.clear()

    for el in main.find_all(["h1", "h2", "h3", "h4", "h5", "p", "li", "td", "div", "span", "strong", "b"]):
        if el.name in ("div", "span", "strong", "b", "td") and el.find(["p", "li", "div", "h1", "h2", "h3", "h4", "h5", "td"]):
            continue  # avoid duplicating text of containers that have their own block children
        text = normalize_text(el.get_text(" ", strip=True))
        if not text:
            continue
        if el.name in ("h1", "h2", "h3", "h4", "h5") or (el.name in ("strong", "b") and text.endswith("?")):
            flush()
            heading = text[:200]
        elif not buf or buf[-1] != text:
            buf.append(text)
    flush()
    # FAQ pages often put the question in plain text followed by the answer; merge tiny sections upward.
    merged: list[TextSection] = []
    for s in sections:
        if merged and merged[-1].heading == s.heading:
            merged[-1].text += "\n" + s.text
        else:
            merged.append(s)
    return title, merged


def looks_like_question(text: str) -> bool:
    return bool(re.search(r"\?\s*$", text.strip()))
