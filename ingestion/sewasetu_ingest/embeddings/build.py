"""Builds int8-quantised, sharded embedding indexes (format read by packages/retrieval/vector.ts)."""
from __future__ import annotations

import base64
import math

from .provider import EmbeddingProvider

SHARD_SIZE = 200
BATCH = 32


def quantize(vec: list[float]) -> str:
    """L2-normalises and quantises a vector to signed int8 (x*127), base64-encoded."""
    norm = math.sqrt(sum(x * x for x in vec)) or 1.0
    ints = [max(-127, min(127, round(x / norm * 127))) for x in vec]
    return base64.b64encode(bytes(i & 0xFF for i in ints)).decode("ascii")


def build_embedding_index(chunks: list[dict], provider: EmbeddingProvider, shard_size: int = SHARD_SIZE) -> tuple[dict, list[dict]]:
    """Embeds every chunk (order == chunk order == BM25 doc index) and shards the vectors."""
    vectors: list[str] = []
    dims = 0
    for start in range(0, len(chunks), BATCH):
        batch = [c["text"] for c in chunks[start : start + BATCH]]
        for v in provider.embed_batch(batch):
            dims = dims or len(v)
            if len(v) != dims:
                raise RuntimeError("inconsistent embedding dimensions")
            vectors.append(quantize(v))
    meta = {"version": 1, "model": provider.model, "dimensions": dims, "doc_ids": [c["chunk_id"] for c in chunks], "shard_size": shard_size}
    shards = [{"v": vectors[i : i + shard_size]} for i in range(0, len(vectors), shard_size)]
    return meta, shards
