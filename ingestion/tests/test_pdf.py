import shutil

import pymupdf
import pytest

from sewasetu_ingest.extractors import pdf as pdfmod
from sewasetu_ingest.extractors.pdf import extract_pdf, ocr_quality


def make_text_pdf(pages: list[str]) -> bytes:
    doc = pymupdf.open()
    for text in pages:
        page = doc.new_page()
        page.insert_text((72, 100), text, fontsize=12)
    out = doc.tobytes()
    doc.close()
    return out


def make_scanned_pdf(text: str) -> bytes:
    """Renders text to an image and embeds only the image - a page with no text layer."""
    src = pymupdf.open()
    p = src.new_page()
    p.insert_text((72, 120), text, fontsize=28)
    pix = p.get_pixmap(dpi=200)
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_image(page.rect, pixmap=pix)
    out = doc.tobytes()
    doc.close(); src.close()
    return out


LONG = "This guideline explains the documents required for the service and the steps to follow for applicants."


def test_text_pdf_pages_are_attributed_and_not_ocred(monkeypatch):
    monkeypatch.setattr(pdfmod, "tesseract_available", lambda: (_ for _ in ()).throw(AssertionError("OCR must not be consulted")))
    result = extract_pdf(make_text_pdf(["Page one. " + LONG, "Page two. " + LONG]))
    assert [p.number for p in result.pages] == [1, 2]
    assert all(p.method == "text" for p in result.pages)
    assert "Page two" in result.pages[1].text
    assert result.method == "pdf_text" and not result.needs_review and result.ocr_pages == []


def test_mixed_pdf_routes_only_the_scanned_page_to_ocr():
    if not shutil.which("tesseract"):
        pytest.skip("tesseract not installed")
    doc = pymupdf.open(stream=make_text_pdf(["Digital page. " + LONG]), filetype="pdf")
    scan = pymupdf.open(stream=make_scanned_pdf("APPLICATION FEES AND DOCUMENTS REQUIRED FOR INCOME CERTIFICATE"), filetype="pdf")
    doc.insert_pdf(scan)
    data = doc.tobytes()
    result = extract_pdf(data)
    methods = {p.number: p.method for p in result.pages}
    assert methods[1] == "text" and methods[2] == "ocr"
    assert result.ocr_pages == [2] and result.method == "pdf_ocr"
    assert "FEES" in result.pages[1].text.upper()


def test_scanned_page_without_ocr_is_flagged_for_review():
    result = extract_pdf(make_scanned_pdf("SCANNED"), ocr=False)
    assert result.needs_review and result.pages == []
    assert any("no text" in w for w in result.warnings)


def test_corrupt_pdf_returns_warnings_instead_of_raising():
    result = extract_pdf(b"%PDF-1.4 this is not really a pdf")
    assert result.pages == [] and result.needs_review and result.warnings


def test_ocr_quality_heuristic():
    assert ocr_quality("Application fees are payable online") > 0.9
    assert ocr_quality("§ ~ ¦ | ¬ ¢ x ^ ` ´") < 0.3
    assert ocr_quality("") == 0.0
