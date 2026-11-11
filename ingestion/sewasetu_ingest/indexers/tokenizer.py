"""Python mirror of ``packages/shared/tokenizer.ts``.

MUST stay behaviour-identical to the TypeScript tokenizer: the Worker tokenizes
queries with the TS version, the index is built here. Both read
``knowledge-schemas/tokenizer.json``; ``tests/test_tokenizer.py`` replays the shared
fixture ``tests/fixtures/tokenizer-cases.json`` to guard parity.
"""
from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[3] / "knowledge-schemas" / "tokenizer.json"
_ASCII_WORD = re.compile(r"^[a-z]+$")


@lru_cache(maxsize=1)
def config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _stopwords() -> frozenset[str]:
    return frozenset(config()["stopwords"])


def _is_token_char(ch: str) -> bool:
    # Letters, combining marks and digits (Unicode categories L*, M*, N*) - same set as /[\p{L}\p{M}\p{N}]+/u.
    return unicodedata.category(ch)[0] in ("L", "M", "N")


def fold_plural(token: str) -> str:
    if not _ASCII_WORD.match(token):
        return token
    if len(token) > 4 and token.endswith("ies"):
        return token[:-3] + "y"
    if len(token) > 3 and token.endswith("s") and not re.search(r"(ss|us|is)$", token):
        return token[:-1]
    return token


def tokenize(text: str) -> list[str]:
    normalised = unicodedata.normalize("NFKC", text).lower()
    min_len = config()["min_token_length"]
    tokens: list[str] = []
    run: list[str] = []
    for ch in normalised + "\0":  # sentinel flushes the last run
        if _is_token_char(ch):
            run.append(ch)
            continue
        if run:
            folded = fold_plural("".join(run))
            is_digits = all(unicodedata.category(c)[0] == "N" for c in folded)
            if (len(folded) >= min_len or is_digits) and folded not in _stopwords():
                tokens.append(folded)
            run = []
    return tokens


def fnv1a32(term: str) -> int:
    """32-bit FNV-1a over UTF-8 bytes (shard assignment); identical to the TS implementation."""
    h = 0x811C9DC5
    for byte in term.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h
