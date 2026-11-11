"""PDF text extraction with page attribution and an OCR fallback for scanned pages.

Strategy (spec 8.2):
  1. PyMuPDF text extraction for every page (fast, exact for digital PDFs).
  2. Only pages that yield (almost) no text are routed to OCR (Tesseract via
     PyMuPDF). Ordinary text PDFs are NEVER OCR-ed.
  3. OCR output is flagged ``method="ocr"`` with a heuristic quality score. Poor
     quality marks the document ``needs_review`` so it can only ever be a draft.
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone

import pymupdf

from ..util import normalize_text

MIN_TEXT_CHARS = 40  # below this a page is treated as scanned/image-only
POOR_OCR_THRESHOLD = 0.55


@dataclass
class PdfPage:
    number: int  # 1-based, as printed in citations
    text: str
    method: str  # "text" | "ocr"
    quality: float | None = None  # OCR heuristic in [0, 1]; None for digital text


@dataclass
class PdfExtraction:
    pages: list[PdfPage] = field(default_factory=list)
    title: str | None = None
    created_at: str | None = None
    modified_at: str | None = None
    page_count: int = 0
    warnings: list[str] = field(default_factory=list)
    needs_review: bool = False

    @property
    def ocr_pages(self) -> list[int]:
        return [p.number for p in self.pages if p.method == "ocr"]

    @property
    def method(self) -> str:
        return "pdf_ocr" if self.ocr_pages else "pdf_text"


def tesseract_available() -> bool:
    return shutil.which("tesseract") is not None


def ocr_quality(text: str) -> float:
    """Heuristic OCR confidence: share of tokens that look like real words.

    PyMuPDF's OCR API exposes no confidence, so we score by the proportion of
    alphabetic tokens of length >= 2 among all whitespace-separated tokens.
    Garbled output (symbols, isolated characters) scores low.
    """
    tokens = text.split()
    if not tokens:
        return 0.0
    good = sum(1 for t in tokens if re.fullmatch(r"[A-Za-zऀ-ॿঀ-৿][A-Za-zऀ-ॿঀ-৿'.,;:()/-]{1,}|\d[\d,./-]*", t))
    return round(good / len(tokens), 3)


def _pdf_date(raw: str | None) -> str | None:
    """Converts PDF dates (``D:20240131120000+05'30'``) to ISO-8601 UTC, or None."""
    if not raw:
        return None
    m = re.match(r"D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?", raw)
    if not m:
        return None
    parts = [int(g) if g else d for g, d in zip(m.groups(), (1970, 1, 1, 0, 0, 0))]
    try:
        return datetime(*parts, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def extract_pdf(data: bytes, *, ocr: bool = True, ocr_language: str = "eng") -> PdfExtraction:
    """Extracts per-page text from PDF bytes. Never raises for malformed files: returns warnings instead."""
    out = PdfExtraction()
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # corrupt/encrypted input
        out.warnings.append(f"could not open PDF: {type(exc).__name__}")
        out.needs_review = True
        return out
    with doc:
        if doc.needs_pass:
            out.warnings.append("PDF is password protected; not processed")
            out.needs_review = True
            return out
        meta = doc.metadata or {}
        out.title = normalize_text(meta.get("title") or "") or None
        out.created_at = _pdf_date(meta.get("creationDate"))
        out.modified_at = _pdf_date(meta.get("modDate"))
        out.page_count = doc.page_count
        ocr_ok: bool | None = None  # resolved lazily: OCR availability is only checked if a scanned page exists
        for index in range(doc.page_count):
            page = doc[index]
            text = page.get_text("text") or ""
            method, quality = "text", None
            if len(text.strip()) < MIN_TEXT_CHARS:
                # Scanned / image-only page: this is the ONLY case that triggers OCR.
                if ocr_ok is None:
                    ocr_ok = bool(ocr) and tesseract_available()
                if ocr_ok:
                    try:
                        tp = page.get_textpage_ocr(language=ocr_language, dpi=200, full=True)
                        text = page.get_text("text", textpage=tp) or ""
                        method, quality = "ocr", ocr_quality(text)
                        if quality < POOR_OCR_THRESHOLD:
                            out.needs_review = True
                            out.warnings.append(f"page {index + 1}: poor OCR quality ({quality})")
                    except Exception as exc:
                        out.warnings.append(f"page {index + 1}: OCR failed ({type(exc).__name__})")
                        out.needs_review = True
                elif len(text.strip()) == 0:
                    out.warnings.append(f"page {index + 1}: no text and OCR unavailable")
                    out.needs_review = True
            text = normalize_text(text)
            if text:
                out.pages.append(PdfPage(number=index + 1, text=text, method=method, quality=quality))
    if not out.pages:
        out.warnings.append("no text could be extracted from the PDF")
        out.needs_review = True
    return out
