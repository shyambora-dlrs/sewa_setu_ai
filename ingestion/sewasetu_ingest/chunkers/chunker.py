"""Chunk generation.

Chunks follow the *structure* of a service (documents, steps, fees...) rather than
arbitrary page length (spec 8.4). A numbered step or a document requirement is
never split across chunks; when a section is too long it is split between items
and the heading line is repeated so every chunk is self-explanatory.

Chunk ids are deterministic (``<service_id>#<section>#<n>``) so the Worker can
filter by service from the id alone and identical content yields identical ids
across releases. Packing a section also back-fills ``source_chunk_id`` on the
items so every fact points at the exact chunk that supports it.
"""
from __future__ import annotations

import re

from ..util import sha256_hex

MAX_CHARS = 900
TAB_FOR_SECTION = {
    "steps": "Guidelines tab", "required_documents": "Requirements tab", "fees": "Requirements tab",
    "eligibility": "Service page", "timeline": "Service page", "appeal": "Service page", "grievance": "Service page", "general": "Service page",
}


def pack_lines(header: str, lines: list[str], max_chars: int = MAX_CHARS) -> list[tuple[str, list[int]]]:
    """Packs ``lines`` into chunks of at most ``max_chars`` (header repeated), splitting only between lines.

    Returns ``[(chunk_text, [line_indices])]``. A single line longer than the budget
    gets its own chunk rather than being cut.
    """
    chunks: list[tuple[str, list[int]]] = []
    cur: list[str] = []
    idx: list[int] = []
    size = len(header)
    for i, line in enumerate(lines):
        if cur and size + len(line) + 1 > max_chars:
            chunks.append((header + "\n" + "\n".join(cur), idx))
            cur, idx, size = [], [], len(header)
        cur.append(line)
        idx.append(i)
        size += len(line) + 1
    if cur:
        chunks.append((header + "\n" + "\n".join(cur), idx))
    return chunks


def _all_manual(items: list[dict]) -> bool:
    """True when every item already points at a reviewer-supplied (``#m``) chunk - no auto chunk is needed."""
    return bool(items) and all("#" in (i.get("source_chunk_id") or "") and "#m" in (i["source_chunk_id"] or "") for i in items)


def _make_chunk(chunk_id, service, section, text, source_url=None, source_title=None, page=None, retrieved_at=None):
    src = service["sources"][0]
    return {
        "chunk_id": chunk_id,
        "service_id": service["service_id"],
        "department_id": service["department"]["department_id"] if service["department"] else None,
        "section_type": section,
        "text": text,
        "source_url": source_url or service["official_page_url"] or src["source_url"],
        "source_title": source_title or src["title"],
        "page_or_section": page or TAB_FOR_SECTION[section],
        "retrieved_at": retrieved_at or src["retrieved_at"],
        "content_hash": sha256_hex(text),
        "language": "en",
    }


def _doc_line(d: dict) -> str:
    label = d["requirement"].capitalize()
    cond = f" ({d['condition']})" if d["condition"] else ""
    return f"- {d['name']} [{label}{cond}]"


def chunk_service(service: dict) -> list[dict]:
    """Creates chunks for one service and links each fact to its chunk (mutates ``service``)."""
    sid, name = service["service_id"], service["service_name"]
    chunks: list[dict] = []

    def emit(section: str, header: str, lines: list[str], items: list[dict] | None):
        for n, (text, idxs) in enumerate(pack_lines(header, lines)):
            chunk_id = f"{sid}#{section}#{len([c for c in chunks if c['section_type'] == section])}"
            chunks.append(_make_chunk(chunk_id, service, section, text))
            if items is not None:
                for i in idxs:
                    items[i]["source_chunk_id"] = chunk_id
            if section == "fees":
                service["fees"]["source_chunk_ids"].append(chunk_id)
            if section == "timeline":
                service["processing_time"]["source_chunk_ids"].append(chunk_id)

    dept = service["department"]["name"] if service["department"] else "department not stated"
    overview = f"{name}. Department: {dept}. Category: {service['category']}. Official Sewa Setu service page: {service['official_page_url']}."
    # Free-text page content (description) is split between lines so long guideline text becomes several focused chunks.
    description_lines = [ln for ln in (service["description"] or "").split("\n") if ln.strip()]
    emit("general", f"{name} - overview", [overview, *description_lines], None)

    docs = service["required_documents"] + service["conditional_documents"]
    if docs:
        emit("required_documents", f"{name} - documents to be enclosed with the application (as labelled on the official page):", [_doc_line(d) for d in docs], docs)
    if service["application_steps"] and not _all_manual(service["application_steps"]):
        emit("steps", f"{name} - application steps:", [f"{s['step']}. {s['text']}" for s in service["application_steps"]], service["application_steps"])
    if service["fees"]["items"]:
        emit("fees", f"{name} - fees and charges:", [f"- {f['raw_text']}" for f in service["fees"]["items"]], None)
    if service["eligibility"] and not _all_manual(service["eligibility"]):
        emit("eligibility", f"{name} - eligibility:", [f"- {s['text']}" for s in service["eligibility"]], service["eligibility"])
    if service["processing_time"]["status"] == "published" and not service["processing_time"]["source_chunk_ids"]:
        emit("timeline", f"{name} - processing time:", [service["processing_time"]["text"] or ""], None)
    if service["appeal_procedure"] and not _all_manual(service["appeal_procedure"]):
        emit("appeal", f"{name} - appeal procedure:", [f"- {s['text']}" for s in service["appeal_procedure"]], service["appeal_procedure"])
    if service["grievance_procedure"] and not _all_manual(service["grievance_procedure"]):
        emit("grievance", f"{name} - grievance procedure:", [f"- {s['text']}" for s in service["grievance_procedure"]], service["grievance_procedure"])
    return chunks


_SENT = re.compile(r"(?<=[.!?])\s+")


def chunk_text_blocks(
    blocks: list[tuple[str, str, str | None]],
    *,
    chunk_prefix: str,
    source_url: str,
    source_title: str,
    retrieved_at: str,
    service_id: str | None = None,
    department_id: str | None = None,
    section_hint: str = "general",
    max_chars: int = 1000,
    id_tag: str = "",
) -> list[dict]:
    """Chunks guideline text: ``blocks = [(heading, text, page_or_section)]``.

    Paragraphs are packed up to ``max_chars``. Only a paragraph that alone exceeds the
    budget is split, at sentence boundaries, with a one-sentence overlap for context.
    """
    chunks: list[dict] = []
    counters: dict[str, int] = {}

    def section_for(heading: str, text: str) -> str:
        probe = f"{heading} {text[:200]}".lower()
        if "appeal" in probe:
            return "appeal"
        if "grievance" in probe or "complaint" in probe:
            return "grievance"
        return section_hint if section_hint in ("appeal", "grievance") else "general"

    def add(section: str, heading: str, text: str, page: str | None):
        n = counters.get(section, 0)
        counters[section] = n + 1
        body = f"{heading}\n{text}" if heading and heading not in text[: len(heading) + 2] else text
        chunks.append({
            "chunk_id": f"{chunk_prefix}#{section}#{id_tag}{n}", "service_id": service_id, "department_id": department_id,
            "section_type": section, "text": body, "source_url": source_url, "source_title": source_title,
            "page_or_section": page, "retrieved_at": retrieved_at, "content_hash": sha256_hex(body), "language": "en",
        })

    for heading, text, page in blocks:
        section = section_for(heading, text)
        paras = [p for p in text.split("\n") if p.strip()]
        buf: list[str] = []
        size = 0
        for para in paras:
            pieces = [para]
            if len(para) > max_chars:  # split an oversized paragraph at sentence boundaries with overlap
                sents, pieces, cur = _SENT.split(para), [], ""
                prev = ""
                for s in sents:
                    if cur and len(cur) + len(s) > max_chars:
                        pieces.append(cur)
                        cur = prev + " " + s if prev else s
                    else:
                        cur = (cur + " " + s).strip()
                    prev = s
                if cur:
                    pieces.append(cur)
            for piece in pieces:
                if buf and size + len(piece) > max_chars:
                    add(section, heading, "\n".join(buf), page)
                    buf, size = [], 0
                buf.append(piece)
                size += len(piece) + 1
        if buf:
            add(section, heading, "\n".join(buf), page)
    return chunks
