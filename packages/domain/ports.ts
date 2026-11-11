/**
 * Ports (interfaces) that the application layer depends on.
 *
 * Infrastructure adapters (R2, Groq, Workers AI, in-memory fakes for tests)
 * implement these. Application code never imports an adapter directly, which is
 * what lets us swap Groq or the embedding provider without touching business
 * rules (Dependency Inversion) and test everything without network access.
 */
import type {
  Bm25Meta, Bm25Shard, Chunk, Department, EmbeddingMeta, Manifest, ReviewState, Service,
  ServiceSummary, SourceRef, CurrentPointer,
} from "../shared/schemas";

/** The active release as resolved from `current.json` + its manifest. */
export interface ReleaseInfo {
  pointer: CurrentPointer;
  manifest: Manifest;
}

/** Read access to the versioned knowledge release. */
export interface KnowledgeRepository {
  /** Resolves the active release. Throws KnowledgeUnavailableError when none is published. */
  getRelease(): Promise<ReleaseInfo>;
  listSummaries(): Promise<ServiceSummary[]>;
  getService(serviceId: string): Promise<Service | null>;
  listDepartments(): Promise<Department[]>;
  /**
   * Fetches chunks by their global index (the position used by the BM25 index).
   * The result is aligned with `indices`; a missing chunk is returned as null.
   */
  getChunksByIndex(indices: number[]): Promise<(Chunk | null)[]>;
  /** Looks up a source reference by id (public metadata only). */
  getSource(sourceId: string): Promise<SourceRef | null>;
}

/** Read access to the keyword/semantic index files of the active release. */
export interface IndexStore {
  getBm25Meta(): Promise<Bm25Meta>;
  getBm25Shard(shard: number): Promise<Bm25Shard>;
  /** Null when the release was built without embeddings. */
  getEmbeddingMeta(): Promise<EmbeddingMeta | null>;
  /** Returns base64 int8 vectors for the given embedding shard. */
  getEmbeddingShard(shard: number): Promise<string[]>;
}

/** Administrator review decisions (approve/reject) layered on top of releases. */
export interface ReviewStateStore {
  get(): Promise<ReviewState>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}
export interface LlmResponse {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}
/** Text-generation provider (Groq today; replaceable). */
export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Produces multilingual query embeddings (Workers AI bge-m3 today). */
export interface EmbeddingProvider {
  readonly model: string;
  embed(text: string): Promise<number[]>;
}

export interface Clock {
  now(): Date;
}
