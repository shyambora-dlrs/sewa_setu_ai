"""Guards parity between the Python index-time tokenizer and the TypeScript query-time tokenizer."""
import json
from pathlib import Path

from sewasetu_ingest.indexers.tokenizer import fnv1a32, tokenize

FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "tokenizer-cases.json"


def test_matches_shared_fixture_generated_by_typescript():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    for case in data["cases"]:
        assert tokenize(case["text"]) == case["tokens"], case["text"]


def test_fnv1a_matches_typescript_hashes():
    for h in json.loads(FIXTURE.read_text(encoding="utf-8"))["hashes"]:
        assert fnv1a32(h["term"]) == h["fnv1a32"]
