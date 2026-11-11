"""Extracts one Sewa Setu service detail page into an :class:`ExtractedService`.

Page anatomy (verified against the live portal): a banner with the department
badge, the service title (h2) and an "Apply Now" link, followed by tab panes -
``#service-guidelines`` (numbered application steps) and ``#service-requirments``
(documents with ``[Mandatory]``/``[Optional]`` labels and a "Fees/Charges" list).

Principles
  * Nothing is inferred. A document is only classed mandatory/optional/conditional
    when the page says so; otherwise it is ``unspecified``.
  * A label such as ``[Mandatory (incase of applying from PFC/CSC)]`` is CONDITIONAL,
    never silently promoted to mandatory.
  * Anything that does not fit a known pattern is kept verbatim in ``notes`` so
    information is not lost, and unknown sections are listed in ``warnings``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Tag

from ..util import normalize_text

DOC_LABEL_RE = re.compile(r"^(?P<name>.*?)\s*\[\s*(?P<label>[^\]]*?)\s*\]\s*$", re.S)
CONDITION_RE = re.compile(r"\((?P<cond>[^)]*)\)")
AMOUNT_RE = re.compile(r"(?:Rs\.?|INR|₹)\s*(?P<amt>\d[\d,]*(?:\.\d+)?)", re.I)
UNIT_RE = re.compile(r"\b(?:per|each)\s+(?P<unit>page|document|copy|certificate|application|day|month|year|km|unit)\b", re.I)
CONDITIONAL_WORDS = re.compile(r"\b(in\s?case|if|when|whenever|applicable|only for|only if|for those)\b", re.I)


@dataclass
class DocItem:
    name: str
    requirement: str  # mandatory | optional | conditional | unspecified
    condition: str | None
    source_text: str


@dataclass
class FeeLine:
    label: str
    amount: float | None
    unit: str | None
    condition: str | None
    raw_text: str


@dataclass
class ExtractedService:
    url: str
    title: str | None = None
    department: str | None = None
    apply_url: str | None = None
    steps: list[str] = field(default_factory=list)
    documents: list[DocItem] = field(default_factory=list)
    fees: list[FeeLine] = field(default_factory=list)
    eligibility: list[str] = field(default_factory=list)
    timeline_text: list[str] = field(default_factory=list)
    appeal_text: list[str] = field(default_factory=list)
    grievance_text: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    pdf_links: list[tuple[str, str]] = field(default_factory=list)  # (url, label)
    tabs: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def parse_doc_label(text: str) -> DocItem:
    """Parses ``Name [Label]`` into a :class:`DocItem`.

    Classification rules (conservative):
      * label containing "optional"                      -> optional
      * label with a parenthesised condition or a
        condition word (incase/if/when ...)              -> conditional (condition kept verbatim)
      * label containing "mandatory"/"required"          -> mandatory
      * no label / unknown label                         -> unspecified
    """
    text = normalize_text(text)
    m = DOC_LABEL_RE.match(text)
    if not m:
        return DocItem(name=text.rstrip(" :;,."), requirement="unspecified", condition=None, source_text=text)
    name, label = normalize_text(m.group("name")), normalize_text(m.group("label"))
    low = label.lower()
    cond_match = CONDITION_RE.search(label)
    condition = normalize_text(cond_match.group("cond")) if cond_match else None
    if not condition and CONDITIONAL_WORDS.search(label):
        condition = normalize_text(re.sub(r"(?i)^\s*(mandatory|optional)\s*", "", label)) or None
    if "optional" in low:
        level = "optional"
    elif condition or "conditional" in low:
        level = "conditional"
    elif "mandatory" in low or "required" in low or "compulsory" in low:
        level = "mandatory"
    else:
        level = "unspecified"
    return DocItem(name=name or text, requirement=level, condition=condition, source_text=text)


def parse_fee_line(text: str) -> FeeLine:
    """Parses a fee line such as ``Printing charge (in case of ...) -Rs. 10 Per Page``.

    The numeric amount is only set when a currency marker is present; otherwise
    the verbatim text is kept with ``amount=None`` (never guessed).
    """
    raw = normalize_text(text)
    amt_m = AMOUNT_RE.search(raw)
    amount = float(amt_m.group("amt").replace(",", "")) if amt_m else None
    unit_m = UNIT_RE.search(raw)
    cond_m = CONDITION_RE.search(raw)
    label_src = raw[: amt_m.start()] if amt_m else raw
    label = normalize_text(CONDITION_RE.sub("", label_src)).strip(" -:–—")
    return FeeLine(
        label=label or raw,
        amount=amount,
        unit=f"per {unit_m.group('unit').lower()}" if unit_m else None,
        condition=normalize_text(cond_m.group("cond")) if cond_m else None,
        raw_text=raw,
    )


def _inside_leaf_li(el: Tag) -> bool:
    """True when ``el`` sits inside a list item that has no nested list items (i.e. an item's own content).

    Some CMS pages wrap the whole tab in one outer ``<li>``; headings inside such a
    *container* li must still be recognised, so only leaf list items count here.
    """
    return any(a.name == "li" and not a.find("li") for a in el.parents)


def _walk(pane: Tag):
    """Yields ``(kind, text)`` in document order. ``kind`` is ``"li"`` (leaf list item) or ``"line"``
    (a paragraph / bold label / heading / bare text block).

    The portal uses two layouts for the Requirements tab and this walker serves both:
      A. headings in bold followed by ``<ol>/<ul>`` lists with ``[Mandatory]`` labels;
      B. flat paragraphs ``<p><b>Label :</b> value</p>`` followed by lists or more paragraphs.
    """
    for el in pane.descendants:
        if not isinstance(el, Tag) or _inside_leaf_li(el):
            continue
        if el.name == "li":
            if not el.find("li"):
                text = normalize_text(el.get_text(" ", strip=True))
                bold = normalize_text(" ".join(b.get_text(" ", strip=True) for b in el.find_all(["b", "strong"])))
                if text:
                    # A list item that is entirely bold and names a section ("Eligibility") is a heading, not an item.
                    yield ("line" if bold == text and _section_for_heading(text) and len(text) < 60 else "li"), text
            continue
        if el.name == "p" and not el.find(["ol", "ul", "li"]):
            text = normalize_text(el.get_text(" ", strip=True))
            if text:
                yield "line", text
        elif el.name in ("b", "strong", "u") and not el.find_parent("p") and not el.find_parent(["b", "strong"]):
            text = normalize_text(el.get_text(" ", strip=True))
            if text:
                yield "line", text
        elif el.name in ("h1", "h2", "h3", "h4", "h5", "h6"):
            text = normalize_text(el.get_text(" ", strip=True))
            if text:
                yield "line", text
        elif el.name == "div":
            own = normalize_text("".join(t for t in el.find_all(string=True, recursive=False)))
            if own:
                yield "line", own


SECTION_PATTERNS = [
    ("fees", re.compile(r"\b(fees?|charges?|payment)\b", re.I)),
    ("documents", re.compile(r"\bdocuments?\b", re.I)),
    ("eligibility", re.compile(r"\beligib", re.I)),
    ("timeline", re.compile(r"\b(time ?limit|timeline|processing time|delivery time|stipulated time|time frame)\b", re.I)),
    ("appeal", re.compile(r"\bappeal", re.I)),
    ("grievance", re.compile(r"\bgrievance|complaint", re.I)),
]
LABEL_RE = re.compile(r"^(?P<label>[^:：]{2,70}?)\s*[:：]\s*(?P<value>.*)$", re.S)
NOT_APPLICABLE_RE = re.compile(r"^[\W_]*(n\s*/?\s*a|not\s+applicable|none|not\s+available|-+)[\W_]*$", re.I)
NIL_RE = re.compile(r"^[\W_]*nil[\W_]*$", re.I)
LEAD_IN_RE = re.compile(r"(:|-|–|—|following|below)\s*$", re.I)
ITEM_MARKER_RE = re.compile(r"^\s*(\(?[a-zA-Z0-9]{1,3}[.)]|[-*•])\s+")


def _section_for_heading(text: str) -> str | None:
    if len(text) > 120:  # long prose is content, not a heading
        return None
    for name, pat in SECTION_PATTERNS:
        if pat.search(text):
            return name
    return None


def _split_label(text: str) -> tuple[str | None, str]:
    """Splits ``"Label : value"``; returns ``(section, value)`` when the label names a known section."""
    m = LABEL_RE.match(text)
    if m:
        sec = _section_for_heading(m.group("label"))
        if sec:
            return sec, normalize_text(m.group("value"))
    # No colon: only a SHORT standalone line counts as a heading ("Fees/Charges"). Prose such as
    # "(a) Proof of payment of fees." mentions a keyword but is an item, not a heading.
    if len(text) <= 50 and not ITEM_MARKER_RE.match(text) and not text.rstrip().endswith((".", ";", ",")):
        return _section_for_heading(text), ""
    return None, ""


def extract_service_page(html: str, url: str) -> ExtractedService:
    """Parses a service detail page. Never raises on odd markup; problems become ``warnings``."""
    soup = BeautifulSoup(html, "lxml")
    out = ExtractedService(url=url)

    banner = soup.select_one(".kys-banner-container")
    if banner:
        h2 = banner.find("h2")
        out.title = normalize_text(h2.get_text(" ", strip=True)) if h2 else None
        badge = banner.select_one("div span")
        out.department = normalize_text(badge.get_text(" ", strip=True)) if badge else None
        apply = banner.select_one("a.apply-btn[href]")
        out.apply_url = apply["href"] if apply else None
    if not out.title:  # fall back to the document title ("Sewa Setu | <name>")
        t = soup.title.get_text(strip=True) if soup.title else ""
        out.title = normalize_text(t.split("|", 1)[-1]) or None
    if not out.title:
        out.warnings.append("service title not found")

    out.tabs = [normalize_text(a.get_text(" ", strip=True)) for a in soup.select("#myTab a.nav-link")]
    panes = soup.select("#myTabContent .tab-pane")
    if not panes:
        out.warnings.append("no content tabs found on the page")

    for pane in panes:
        label = pane.get("id", "")
        if label == "service-guidelines":
            _read_guidelines(pane, out)
        else:  # requirements and any other tab are read with the heading-aware walker
            _read_sections(pane, out)
        for a in pane.find_all("a", href=True):
            if re.search(r"(\.pdf(\?|$)|/docs_download\?)", a["href"], re.I):
                out.pdf_links.append((a["href"], normalize_text(a.get_text(" ", strip=True)) or "Linked document"))

    if not out.steps:
        out.warnings.append("application steps not found")
    if not out.documents:
        out.warnings.append("document requirements not found")
    if not out.fees:
        out.warnings.append("fees not published on the page")
    return out


def _read_guidelines(pane: Tag, out: ExtractedService) -> None:
    """The guidelines tab is an ordered list of application steps; plain paragraphs become notes."""
    items = [t for kind, t in _walk(pane) if kind == "li"]
    if items:
        out.steps.extend(items)
        return
    paragraphs = [t for kind, t in _walk(pane) if kind == "line"]
    text = normalize_text("\n".join(paragraphs)) or normalize_text(pane.get_text("\n", strip=True))
    if text:
        out.notes.append(text)


def _route(out: ExtractedService, section: str | None, text: str, from_list: bool) -> None:
    """Stores one piece of text in the structure for ``section``; unknown context keeps it verbatim as a note."""
    if section == "fees":
        out.fees.append(parse_fee_line(text))
    elif section == "documents" and (from_list or DOC_LABEL_RE.match(text) or not LEAD_IN_RE.search(text)):
        out.documents.append(parse_doc_label(ITEM_MARKER_RE.sub("", text)))
    elif section == "eligibility":
        out.eligibility.append(text)
    elif section == "timeline":
        out.timeline_text.append(text)
    elif section == "appeal":
        out.appeal_text.append(text)
    elif section == "grievance":
        out.grievance_text.append(text)
    else:
        out.notes.append(text)


def _read_sections(pane: Tag, out: ExtractedService) -> None:
    """Walks labels and items, classifying each by the section label above it (or inline ``Label : value``).

    ``N/A`` style values mean "not applicable / nothing published" and are kept only as a note;
    ``NIL`` under fees is a published statement and is kept as a fee line with no numeric amount.
    """
    section: str | None = None
    for kind, text in _walk(pane):
        if kind == "li":
            _route(out, section, text, from_list=True)
            continue
        label_section, value = _split_label(text)
        if label_section:
            section = label_section
            if value:
                if NOT_APPLICABLE_RE.match(value):
                    out.notes.append(f"{text}")
                elif NIL_RE.match(value) and section == "fees":
                    out.fees.append(FeeLine(label="Fees", amount=None, unit=None, condition=None, raw_text=normalize_text(value)))
                else:
                    _route(out, section, value, from_list=False)
        elif len(text) > 3:
            _route(out, section, text, from_list=False)
