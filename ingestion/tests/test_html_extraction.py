from conftest import fx
from sewasetu_ingest.crawler.discovery import discover_document_links, merge_refs, parse_directory
from sewasetu_ingest.extractors.html_generic import extract_sections
from sewasetu_ingest.extractors.html_service import extract_service_page, parse_doc_label, parse_fee_line

BASE = "https://test.example.gov.in"


def test_directory_parsing_dedupes_and_maps_department():
    refs = parse_directory(fx("directory-citizen.html"), BASE + "/site/online/citizen", "citizen")
    assert [r.slug for r in refs] == ["test-income-certificate", "test-trade-licence"]
    assert refs[0].department == "TEST FIXTURE Revenue Department"
    assert refs[0].name == "TEST FIXTURE Income Certificate"


def test_merge_keeps_first_category_and_reports_duplicates():
    a = parse_directory(fx("directory-citizen.html"), BASE + "/site/online/citizen", "citizen")
    b = parse_directory(fx("directory-schemes.html"), BASE + "/site/online/schemes", "schemes")
    merged, dupes = merge_refs([a, b])
    by_slug = {r.slug: r for r in merged}
    assert by_slug["test-income-certificate"].category == "citizen"
    assert by_slug["test-scholarship"].category == "schemes"  # relative link resolved
    assert [d.slug for d in dupes] == ["test-income-certificate"]


def test_service_page_extraction():
    ex = extract_service_page(fx("service-income.html"), BASE + "/site/service-apply/test-income-certificate")
    assert ex.title == "TEST FIXTURE Income Certificate"
    assert ex.department == "TEST FIXTURE Revenue Department"
    assert ex.apply_url == "https://test.example.gov.in/apply/income"
    assert len(ex.steps) == 3 and ex.steps[0].startswith("Register")
    by_name = {d.name: d for d in ex.documents}
    assert by_name["Address Proof"].requirement == "mandatory"
    assert by_name["Salary Slip"].requirement == "optional"
    assert ex.pdf_links[0][0].endswith("guideline.pdf")


def test_conditional_requirement_is_never_promoted_to_mandatory():
    d = parse_doc_label("Upload Scanned Copy of the Application Form [ Mandatory (incase of applying from PFC/CSC)]")
    assert d.requirement == "conditional"
    assert d.condition == "incase of applying from PFC/CSC"
    assert parse_doc_label("Birth proof [Mandatory if age below 18]").requirement == "conditional"


def test_unlabelled_document_is_unspecified_not_guessed():
    ex = extract_service_page(fx("service-income.html"), BASE + "/x")
    caste = next(d for d in ex.documents if d.name == "Caste proof")
    assert caste.requirement == "unspecified" and caste.condition is None


def test_fee_parsing_keeps_unparseable_text_without_inventing_amounts():
    assert parse_fee_line("User/Statutory charges -Rs. 30").amount == 30
    printing = parse_fee_line("Printing charge (in case of any printing from PFC/CSC) -Rs. 10 Per Page")
    assert (printing.amount, printing.unit, printing.condition) == (10, "per page", "in case of any printing from PFC/CSC")
    assert parse_fee_line("Convenience fee- Rs. 10/-").amount == 10
    subject = parse_fee_line("Subject to rules")
    assert subject.amount is None and subject.raw_text == "Subject to rules"
    assert parse_fee_line("Fee Rs. 1,250.50").amount == 1250.5


def test_missing_sections_become_warnings_not_data():
    ex = extract_service_page(fx("service-trade.html"), BASE + "/y")
    assert ex.documents == [] and ex.fees == []
    assert {"document requirements not found", "fees not published on the page"} <= set(ex.warnings)
    assert ex.timeline_text == []  # "within 15 working days" in prose is NOT promoted to a timeline


def test_eligibility_and_timeline_sections_are_read_when_explicit():
    ex = extract_service_page(fx("service-scholarship.html"), BASE + "/z")
    assert ex.eligibility == ["Applicant must be a student."]
    assert ex.timeline_text == ["30 days"]


def test_generic_sections_and_document_links():
    title, sections = extract_sections(fx("appeal-page.html"), "fallback")
    assert title == "TEST FIXTURE Raise an Appeal"
    assert any("first appellate authority" in s.text for s in sections)
    links = discover_document_links(fx("appeal-page.html"), BASE + "/site/appeal-raise")
    assert {l.url.rsplit("/", 1)[-1] for l in links} == {"appeal-manual.pdf", "site/docs_download?p=abc123".rsplit("/", 1)[-1]}
    assert any(l.label == "Acts" for l in links)


# ---- second Requirements-tab layout found on the live portal (flat "Label : value" paragraphs) ----

def test_flat_paragraph_layout_documents_time_limit_and_nil_fee():
    ex = extract_service_page(fx("service-flat.html"), BASE + "/f")
    assert [d.name for d in ex.documents] == ["Proof of payment of fees", "Copy of the previous certificate"]
    assert all(d.requirement == "unspecified" for d in ex.documents)  # no label on the page => not guessed
    assert ex.timeline_text == ["15 days"]
    assert [(f.raw_text, f.amount) for f in ex.fees] == [("NIL", None)]
    assert "The application has to be accompanied by the following documents -" in ex.notes  # lead-in sentence is not a document
    assert ex.notes and ex.steps == []  # prose guidelines are kept as a note, not turned into steps


def test_flat_layout_with_lists_and_inline_time_limit():
    ex = extract_service_page(fx("service-flat-lists.html"), BASE + "/g")
    assert [d.name for d in ex.documents] == ["Forwarding letter through the Principal", "Photo copy of mark sheet"]
    assert ex.timeline_text == ["90 working days from the date of application"]
    assert [f.amount for f in ex.fees] == [200.0, 10.0, None]
    assert ex.fees[1].unit == "per page"


def test_not_applicable_values_are_not_turned_into_data():
    ex = extract_service_page(fx("service-na.html"), BASE + "/n")
    assert ex.documents == [] and ex.timeline_text == []
    assert any("N/A" in n for n in ex.notes)  # kept verbatim as a note
    assert [f.amount for f in ex.fees] == [30.0]
