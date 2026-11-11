/**
 * R2-backed implementation of KnowledgeRepository and IndexStore.
 *
 * Release resolution (spec section 6.1):
 *   1. read `current.json` (the only mutable object; cached briefly)
 *   2. read every other object from the immutable path `releases/<release_id>/...`
 *
 * Caching: objects under an immutable release path never change, so they are
 * cached in isolate memory keyed by release id + path. A new release has a new
 * id, hence new cache keys - stale index data can never be reused. Only the
 * pointer is cached with a short TTL so a freshly published release becomes
 * visible within `pointerTtlMs`.
 *
 * Isolation: only this class knows R2 key layout. Callers pass ids, never keys,
 * and service ids are validated before being embedded in a key (no path tricks).
 */
import type { IndexStore, KnowledgeRepository, ReleaseInfo } from "../../packages/domain/ports";
import { KnowledgeUnavailableError } from "../../packages/domain/errors";
import { R2_KEYS } from "../../packages/shared/constants";
import {
  Bm25Meta, Chunk, CurrentPointer, Department, EmbeddingMeta, Manifest, Service, ServiceSummary, SourceRef,
  type Bm25Shard,
} from "../../packages/shared/schemas";
import type { z } from "zod";

const SERVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,200}$/;

export interface R2RepositoryOptions {
  /** How long the `current.json` pointer is trusted before re-reading (ms). */
  pointerTtlMs: number;
  /** Max cached immutable objects per isolate (bounds memory on a 128 MB Worker). */
  maxCacheEntries: number;
}

export const DEFAULT_R2_OPTIONS: R2RepositoryOptions = { pointerTtlMs: 30_000, maxCacheEntries: 64 };

export class R2KnowledgeRepository implements KnowledgeRepository, IndexStore {
  private pointer: { value: ReleaseInfo; fetchedAt: number } | null = null;
  private readonly cache = new Map<string, unknown>();

  constructor(
    private readonly bucket: R2Bucket,
    private readonly options: R2RepositoryOptions = DEFAULT_R2_OPTIONS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Reads and validates `current.json` and the manifest it points to. */
  async getRelease(): Promise<ReleaseInfo> {
    const cached = this.pointer;
    if (cached && this.now() - cached.fetchedAt < this.options.pointerTtlMs) return cached.value;

    const obj = await this.bucket.get(R2_KEYS.current);
    if (!obj) throw new KnowledgeUnavailableError("No knowledge release has been published yet.");
    const pointer = this.parse(CurrentPointer, await obj.text(), R2_KEYS.current);
    const manifest = await this.readImmutable(pointer.release_id, "manifest.json", Manifest);
    const info = { pointer, manifest };
    this.pointer = { value: info, fetchedAt: this.now() };
    return info;
  }

  async listSummaries(): Promise<ServiceSummary[]> {
    const { pointer } = await this.getRelease();
    const parsed = await this.readImmutableRaw(pointer.release_id, "catalog/summaries.json");
    return (parsed as unknown[]).map((s) => ServiceSummary.parse(s));
  }

  async getService(serviceId: string): Promise<Service | null> {
    if (!SERVICE_ID_RE.test(serviceId)) return null; // never build an R2 key from unvalidated input
    const { pointer } = await this.getRelease();
    const key = `${R2_KEYS.releasePrefix(pointer.release_id)}catalog/services/${serviceId}.json`;
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return this.parse(Service, await obj.text(), key);
  }

  async listDepartments(): Promise<Department[]> {
    const { pointer } = await this.getRelease();
    const raw = await this.readImmutableRaw(pointer.release_id, "catalog/departments.json");
    return (raw as unknown[]).map((d) => Department.parse(d));
  }

  async getChunksByIndex(indices: number[]): Promise<(Chunk | null)[]> {
    const { pointer, manifest } = await this.getRelease();
    const size = manifest.chunk_shard_size;
    // Indices beyond chunk_count do not exist: answer null without touching R2.
    const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < manifest.chunk_count);
    const shardIds = [...new Set(valid.map((i) => Math.floor(i / size)))];
    const shards = new Map<number, Chunk[]>();
    await Promise.all(
      shardIds.map(async (n) => {
        const path = `chunks/chunk-shard-${String(n).padStart(3, "0")}.json`;
        shards.set(n, (await this.readImmutableRaw(pointer.release_id, path)) as Chunk[]);
      }),
    );
    return indices.map((i) => (valid.includes(i) ? (shards.get(Math.floor(i / size))?.[i % size] ?? null) : null));
  }

  async getSource(sourceId: string): Promise<SourceRef | null> {
    const { pointer } = await this.getRelease();
    const all = (await this.readImmutableRaw(pointer.release_id, "catalog/sources.json")) as Record<string, unknown>;
    const found = Object.prototype.hasOwnProperty.call(all, sourceId) ? all[sourceId] : undefined;
    return found ? SourceRef.parse(found) : null;
  }

  /* ---------------------------- IndexStore ---------------------------- */

  async getBm25Meta(): Promise<Bm25Meta> {
    const { pointer, manifest } = await this.getRelease();
    return this.readImmutable(pointer.release_id, manifest.retrieval.keyword_index, Bm25Meta);
  }

  async getBm25Shard(shard: number): Promise<Bm25Shard> {
    const { pointer, manifest } = await this.getRelease();
    const dir = manifest.retrieval.keyword_index.replace(/meta\.json$/, "");
    const name = `shard-${String(shard).padStart(2, "0")}.json`;
    return (await this.readImmutableRaw(pointer.release_id, `${dir}${name}`)) as Bm25Shard;
  }

  async getEmbeddingMeta(): Promise<EmbeddingMeta | null> {
    const { pointer, manifest } = await this.getRelease();
    if (!manifest.retrieval.embedding_index) return null;
    return this.readImmutable(pointer.release_id, manifest.retrieval.embedding_index, EmbeddingMeta);
  }

  async getEmbeddingShard(shard: number): Promise<string[]> {
    const { pointer, manifest } = await this.getRelease();
    if (!manifest.retrieval.embedding_index) return [];
    const dir = manifest.retrieval.embedding_index.replace(/meta\.json$/, "");
    const raw = (await this.readImmutableRaw(pointer.release_id, `${dir}shard-${String(shard).padStart(3, "0")}.json`)) as { v: string[] };
    return raw.v;
  }

  /* ------------------------------ helpers ----------------------------- */

  private parse<S extends z.ZodType>(schema: S, text: string, key: string): z.infer<S> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new KnowledgeUnavailableError(`Knowledge object is not valid JSON: ${key}`);
    }
    const result = schema.safeParse(json);
    if (!result.success) throw new KnowledgeUnavailableError(`Knowledge object failed schema validation: ${key}`);
    return result.data;
  }

  /** Reads + validates an immutable release object, memoised per release/path. */
  private async readImmutable<S extends z.ZodType>(releaseId: string, path: string, schema: S): Promise<z.infer<S>> {
    const cacheKey = `${releaseId}/${path}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey) as z.infer<S>;
    const key = `${R2_KEYS.releasePrefix(releaseId)}${path}`;
    const obj = await this.bucket.get(key);
    if (!obj) throw new KnowledgeUnavailableError(`Release object is missing: ${path}`, { release_id: releaseId });
    const value = this.parse(schema, await obj.text(), key);
    this.remember(cacheKey, value);
    return value;
  }

  /** Same as readImmutable but without schema validation (large, publish-time-validated files). */
  private async readImmutableRaw(releaseId: string, path: string): Promise<unknown> {
    const cacheKey = `${releaseId}/${path}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const key = `${R2_KEYS.releasePrefix(releaseId)}${path}`;
    const obj = await this.bucket.get(key);
    if (!obj) throw new KnowledgeUnavailableError(`Release object is missing: ${path}`, { release_id: releaseId });
    let value: unknown;
    try {
      value = await obj.json();
    } catch {
      throw new KnowledgeUnavailableError(`Release object is not valid JSON: ${path}`, { release_id: releaseId });
    }
    this.remember(cacheKey, value);
    return value;
  }

  /** Tiny FIFO cache; Map iteration order == insertion order. */
  private remember(key: string, value: unknown) {
    if (this.cache.size >= this.options.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, value);
  }
}
