import copy

from conftest import fx
from sewasetu_ingest.chunkers.chunker import chunk_service, chunk_text_blocks, pack_lines
from sewasetu_ingest.crawler.discovery import ServiceRef
from sewasetu_ingest.crawler.http import FetchResult
from sewasetu_ingest.extractors.html_service import extract_service_page
from sewasetu_ingest.indexers.bm25 import build_bm25
from sewasetu_ingest.indexers.tokenizer import fnv1a32, tokenize
from sewasetu_ingest.normalizers.dedupe import dedupe_by_canonical_url, find_duplicate_content
from sewasetu_ingest.normalizers.service import build_service, compute_content_hash, parse_processing_time
from sewasetu_ingest.util import canonical_url, normalize_text, sha256_hex, slugify

URL = "https://test.example.gov.in/site/service-apply/test-income-certificate"


def make(html="service-income.html", slug="test-income-certificate", retrieved="2026-11-11T10:00:00Z"):
    ref = ServiceRef(url=f"https://test.example.gov.in/site/service-apply/{slug}", slug=slug, name="TEST FIXTURE x", department="TEST FIXTURE Dept", category="citizen")
    fetched = FetchResult(ref.url, ref.url, 200, b"x", "text/html", None, None, sha256_hex(fx(html)), retrieved)
    return build_service(ref, extract_service_page(fx(html), ref.url), fetched, retrieved)


def test_service_defaults_to_draft_and_unknowns_stay_unknown():
    s = make("service-trade.html", "test-trade-licence")
    assert s["publication_status"] == "draft" and s["last_verified_at"] is None
    assert s["fees"]["status"] == "not_published" and s["fees"]["items"] == []
    assert s["processing_time"]["status"] == "not_published" and s["processing_time"]["value"] is None
    assert s["eligibility"] == [] and s["designated_authority"] is None and s["appeal_procedure"] == []
    assert s["sources"][0]["source_url"].startswith("https://")


def test_documents_are_split_by_level_and_conditions_kept():
    s = make()
    assert {d["name"] for d in s["required_documents"] if d["requirement"] == "mandatory"} == {"Address Proof", "Identity Proof"}
    assert s["conditional_documents"][0]["condition"] == "incase of applying from PFC/CSC"
    assert all(d["requirement"] != "conditional" for d in s["required_documents"])


def test_content_hash_is_stable_across_refetch_and_changes_with_content():
    a, b = make(retrieved="2026-11-11T10:00:00Z"), make(retrieved="2026-12-01T10:00:00Z")
    assert a["content_hash"] == b["content_hash"]  # timestamps do not count as a change
    c = copy.deepcopy(a)
    c["application_steps"][0]["text"] = "Different official step"
    assert compute_content_hash(c) != a["content_hash"]


def test_processing_time_parsed_only_when_unambiguous():
    assert parse_processing_time(["Within 15 working days"])["unit"] == "working_days"
    amb = parse_processing_time(["7 days for urban, 15 days for rural"])
    assert amb["value"] is None and amb["text"]  # ambiguous: text kept, number not guessed
    assert parse_processing_time([])["status"] == "not_published"


def test_chunks_follow_sections_and_link_facts_to_chunks():
    s = make()
    chunks = chunk_service(s)
    sections = {c["section_type"] for c in chunks}
    assert {"general", "required_documents", "steps", "fees"} <= sections
    ids = {c["chunk_id"] for c in chunks}
    assert len(ids) == len(chunks)
    assert all(c["chunk_id"].startswith("test-income-certificate#") for c in chunks)
    assert all(d["source_chunk_id"] in ids for d in s["required_documents"] + s["conditional_documents"])
    assert s["fees"]["source_chunk_ids"] and set(s["fees"]["source_chunk_ids"]) <= ids
    doc_chunk = next(c for c in chunks if c["section_type"] == "required_documents")
    assert "[Conditional (incase of applying from PFC/CSC)]" in doc_chunk["text"]  # conditional label preserved


def test_pack_lines_never_splits_an_item_and_repeats_the_header():
    lines = [f"{i}. " + "x" * 300 for i in range(1, 8)]
    packed = pack_lines("Steps:", lines, max_chars=700)
    assert len(packed) > 1
    for text, idxs in packed:
        assert text.startswith("Steps:\n")
        for i in idxs:
            assert lines[i] in text
    assert sorted(i for _, idxs in packed for i in idxs) == list(range(7))


def test_text_block_chunking_splits_long_paragraphs_at_sentences_with_overlap():
    para = " ".join(f"Sentence number {i} explains the appeal process in detail." for i in range(40))
    chunks = chunk_text_blocks([("Appeal manual", para, "p. 1")], chunk_prefix="general~src", source_url="https://t.example.gov.in/a", source_title="t", retrieved_at="2026-11-11T10:00:00Z", max_chars=300)
    assert len(chunks) > 3
    assert all(len(c["text"]) < 450 for c in chunks)
    assert all(c["section_type"] == "appeal" for c in chunks)  # classified from the heading
    assert len({c["chunk_id"] for c in chunks}) == len(chunks)


def test_bm25_index_structure_and_sharding():
    chunks = chunk_service(make())
    meta, shards = build_bm25(chunks)
    assert meta["doc_count"] == len(chunks) and meta["doc_ids"] == [c["chunk_id"] for c in chunks]
    assert len(shards) == meta["shard_count"] == 16
    postings = shards[fnv1a32("certificate") % 16]["certificate"]
    assert all(0 <= d < len(chunks) and tf >= 1 for d, tf in postings)
    # every indexed term lives in the shard its hash dictates
    for n, shard in enumerate(shards):
        for term in shard:
            assert fnv1a32(term) % 16 == n
    assert any(t in shards[fnv1a32(t) % 16] for t in tokenize("address proof"))


def test_duplicate_detection_and_helpers():
    uniq, dropped = dedupe_by_canonical_url(["https://A.example.gov.in/x/", "https://a.example.gov.in/x", "https://a.example.gov.in/y?z=1"])
    assert uniq == ["https://A.example.gov.in/x/", "https://a.example.gov.in/y?z=1"] and dropped == ["https://a.example.gov.in/x"]
    assert find_duplicate_content([("a", "h1"), ("b", "h1"), ("c", "h2")]) == {"h1": ["a", "b"]}
    assert canonical_url("HTTPS://X.com//a//b/?q=1#f") == "https://x.com/a/b"
    assert normalize_text("a  b​\n\n\n c") == "a b\nc"
    assert slugify("Add/Modify Nominee in RC!") == "add-modify-nominee-in-rc"
