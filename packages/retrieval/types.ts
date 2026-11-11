import type { Chunk, SectionType } from "../shared/schemas";

export interface RetrievalRequest {
  /** Tokenized (and lexicon-expanded) query terms for BM25. */
  terms: string[];
  /** Raw question text, embedded when semantic retrieval is enabled. */
  text: string;
  /** Restrict retrieval to these services (explicit user choice or resolved intent). */
  serviceIds?: string[];
  limit: number;
}

export interface ScoredChunk {
  chunk: Chunk;
  chunkIndex: number;
  /** Final fused score used for ordering. */
  score: number;
  bm25: number | null;
  semantic: number | null;
  /**
   * 0..1 share of the question's term weight matched by this chunk (BM25 coverage), or 1 when a
   * strong semantic match vouches for it. Low coverage means "matched only generic words".
   */
  coverage: number;
}

/** Strategy interface so the RAG service is agnostic to BM25-only vs hybrid retrieval. */
export interface ChunkRetriever {
  retrieve(req: RetrievalRequest): Promise<ScoredChunk[]>;
}

export type { SectionType };
