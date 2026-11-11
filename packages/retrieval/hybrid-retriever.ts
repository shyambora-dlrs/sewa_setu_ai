/**
 * Chunk retrieval: BM25 first, optional semantic re-ranking second.
 *
 * Data flow for one question
 *   1. BM25 over the sharded chunk index  -> top K candidates (bounded)
 *   2. (optional) embed the question via the EmbeddingProvider; score candidates
 *      by cosine similarity against stored int8 vectors
 *   3. Reciprocal Rank Fusion merges the two rankings
 *   4. Winning chunk indices are fetched from the chunk shards (few R2 reads)
 *
 * Semantic scoring is deliberately *bounded*: it only scores BM25 candidates,
 * unless BM25 found nothing (typical for Assamese/Hindi questions against
 * English content) and the corpus is small enough to scan within the Worker's
 * CPU budget (`semanticMaxScan`). No unbounded vector scan is ever performed.
 */
import type { EmbeddingProvider, IndexStore, KnowledgeRepository } from "../domain/ports";
import { Bm25Searcher, type Bm25Source } from "./bm25";
import type { ChunkRetriever, RetrievalRequest, ScoredChunk } from "./types";
import { cosineInt8, decodeInt8Base64, l2Normalize } from "./vector";

export interface HybridRetrieverOptions {
  /** How many BM25 candidates feed fusion/semantic scoring. */
  candidateLimit: number;
  /** Maximum corpus size for the semantic fallback scan when BM25 is empty. */
  semanticMaxScan: number;
  /** RRF constant; 60 is the conventional default. */
  rrfK: number;
  /** Cosine similarity at which a semantic match alone counts as relevant (bge-m3 scores; tune after evaluation). */
  strongSemantic: number;
}

export const DEFAULT_HYBRID_OPTIONS: HybridRetrieverOptions = {
  candidateLimit: 24,
  semanticMaxScan: 4000,
  rrfK: 60,
  strongSemantic: 0.55,
};

export class HybridRetriever implements ChunkRetriever {
  private readonly bm25: Bm25Searcher;

  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly index: IndexStore,
    private readonly embedder: EmbeddingProvider | null,
    private readonly options: HybridRetrieverOptions = DEFAULT_HYBRID_OPTIONS,
  ) {
    const source: Bm25Source = {
      getMeta: () => index.getBm25Meta(),
      getShard: (n) => index.getBm25Shard(n),
    };
    this.bm25 = new Bm25Searcher(source);
  }

  async retrieve(req: RetrievalRequest): Promise<ScoredChunk[]> {
    const meta = await this.index.getBm25Meta();
    const allowed = req.serviceIds?.length ? this.docsForServices(meta.doc_ids, req.serviceIds) : null;
    if (allowed && allowed.size === 0) return [];

    const keywordHits = await this.bm25.search(req.terms, {
      limit: Math.max(this.options.candidateLimit, req.limit),
      allowedDocs: allowed,
    });

    const semanticScores = await this.semanticScores(req.text, keywordHits.map((h) => h.docIndex), allowed, meta.doc_count);

    // Reciprocal Rank Fusion: robust to the very different score scales of BM25 and cosine.
    const fused = new Map<number, { score: number; bm25: number | null; semantic: number | null; coverage: number }>();
    const add = (docIndex: number, rank: number, patch: { bm25?: number; semantic?: number; coverage?: number }) => {
      const cur = fused.get(docIndex) ?? { score: 0, bm25: null, semantic: null, coverage: 0 };
      cur.score += 1 / (this.options.rrfK + rank + 1);
      if (patch.bm25 !== undefined) cur.bm25 = patch.bm25;
      if (patch.semantic !== undefined) cur.semantic = patch.semantic;
      if (patch.coverage !== undefined) cur.coverage = Math.max(cur.coverage, patch.coverage);
      fused.set(docIndex, cur);
    };
    keywordHits.forEach((h, rank) => add(h.docIndex, rank, { bm25: h.score, coverage: h.coverage }));
    // A strong cosine match is independent evidence of relevance even when no keyword overlaps.
    semanticScores.forEach((s, rank) => add(s.docIndex, rank, { semantic: s.score, coverage: s.score >= this.options.strongSemantic ? 1 : 0 }));

    const winners = [...fused.entries()]
      .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
      .slice(0, Math.max(this.options.candidateLimit, req.limit));
    if (winners.length === 0) return [];

    const chunks = await this.repo.getChunksByIndex(winners.map(([i]) => i));
    const out: ScoredChunk[] = [];
    winners.forEach(([chunkIndex, s], pos) => {
      const chunk = chunks[pos];
      if (chunk) out.push({ chunk, chunkIndex, score: s.score, bm25: s.bm25, semantic: s.semantic, coverage: s.coverage });
    });
    return out;
  }

  /**
   * Chunk ids are `<service_id>#<section>#<n>`, so service filtering needs no extra
   * lookup file: we derive the allowed doc indices from the id prefix.
   */
  private docsForServices(docIds: string[], serviceIds: string[]): Set<number> {
    const prefixes = serviceIds.map((s) => `${s}#`);
    const out = new Set<number>();
    docIds.forEach((id, i) => {
      if (prefixes.some((p) => id.startsWith(p))) out.add(i);
    });
    return out;
  }

  /** Returns candidates sorted by cosine similarity; empty when embeddings are unavailable. */
  private async semanticScores(
    text: string,
    candidateIdx: number[],
    allowed: ReadonlySet<number> | null,
    docCount: number,
  ): Promise<{ docIndex: number; score: number }[]> {
    if (!this.embedder) return [];
    const embMeta = await this.index.getEmbeddingMeta();
    if (!embMeta || embMeta.model !== this.embedder.model) return []; // never mix vectors from different models

    let targets = candidateIdx;
    if (targets.length === 0) {
      if (docCount > this.options.semanticMaxScan) return []; // refuse unbounded scans
      targets = allowed ? [...allowed] : Array.from({ length: docCount }, (_, i) => i);
    }
    if (targets.length === 0) return [];

    let query: number[];
    try {
      query = l2Normalize(await this.embedder.embed(text));
    } catch {
      return []; // embedding outage degrades gracefully to BM25-only
    }
    if (query.length !== embMeta.dimensions) return [];

    // Load only the vector shards that contain the target documents.
    const shardIds = [...new Set(targets.map((i) => Math.floor(i / embMeta.shard_size)))];
    const shards = new Map<number, string[]>();
    await Promise.all(shardIds.map(async (s) => shards.set(s, await this.index.getEmbeddingShard(s))));

    const scored = targets.map((docIndex) => {
      const vec = shards.get(Math.floor(docIndex / embMeta.shard_size))?.[docIndex % embMeta.shard_size];
      return { docIndex, score: vec ? cosineInt8(query, decodeInt8Base64(vec)) : -1 };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, this.options.candidateLimit);
  }
}
