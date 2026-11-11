"""BM25 inverted-index builder (sharded by term hash).

Output layout (consumed by ``packages/retrieval/bm25.ts``)::

    indexes/bm25-v1/meta.json        doc ids/lengths + global statistics
    indexes/bm25-v1/shard-NN.json    {term: [[docIndex, termFreq], ...]}

``docIndex`` is the position of the chunk in the global chunk order, which is also
how chunk shards are addressed - so no separate lookup table is required.
"""
from __future__ import annotations

from collections import Counter

from .tokenizer import config, fnv1a32, tokenize


def build_bm25(chunks: list[dict]) -> tuple[dict, list[dict]]:
    """Returns ``(meta, shards)`` for the given ordered chunks."""
    cfg = config()["bm25"]
    shard_count = cfg["shard_count"]
    shards: list[dict[str, list[list[int]]]] = [{} for _ in range(shard_count)]
    doc_lens: list[int] = []
    for doc_index, chunk in enumerate(chunks):
        tokens = tokenize(chunk["text"])
        doc_lens.append(len(tokens))
        for term, tf in Counter(tokens).items():
            shards[fnv1a32(term) % shard_count].setdefault(term, []).append([doc_index, tf])
    meta = {
        "version": 1, "k1": cfg["k1"], "b": cfg["b"], "doc_count": len(chunks),
        "avg_doc_len": (sum(doc_lens) / len(doc_lens)) if doc_lens else 0,
        "shard_count": shard_count, "doc_ids": [c["chunk_id"] for c in chunks], "doc_lens": doc_lens,
    }
    return meta, shards
