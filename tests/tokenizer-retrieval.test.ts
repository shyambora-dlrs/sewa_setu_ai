import { describe, expect, it } from "vitest";
import fixture from "./fixtures/tokenizer-cases.json";
import { Bm25Searcher, buildInMemoryBm25 } from "../packages/retrieval/bm25";
import { detectSectionIntent, rankAndDeduplicate } from "../packages/retrieval/chunk-ranker";
import { buildContext, sanitizeSourceText } from "../packages/retrieval/context-builder";
import { expandQueryTerms } from "../packages/retrieval/lexicon";
import { HybridRetriever } from "../packages/retrieval/hybrid-retriever";
import { encodeInt8Base64, l2Normalize } from "../packages/retrieval/vector";
import { fnv1a32, tokenize } from "../packages/shared/tokenizer";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { buildChunks, seedRelease } from "./helpers/fixture-release";
import { R2KnowledgeRepository } from "../worker/adapters/r2-knowledge-repository";
import type { EmbeddingProvider } from "../packages/domain/ports";

describe("tokenizer", () => {
  it.each(fixture.cases)("matches the shared fixture: $text", ({ text, tokens }) => {
    expect(tokenize(text)).toEqual(tokens);
  });
  it("hashes terms like the Python indexer (FNV-1a)", () => {
    for (const { term, fnv1a32: h } of fixture.hashes) expect(fnv1a32(term)).toBe(h);
  });
  it("keeps Indic combining marks and drops stopwords", () => {
    expect(tokenize("the আবেদন")).toEqual(["আবেদন"]);
  });
});

describe("BM25 retrieval", () => {
  const docs = [
    { id: "a", text: "income certificate documents address proof" },
    { id: "b", text: "trade licence application steps" },
    { id: "c", text: "income tax receipt land revenue" },
  ];
  const searcher = new Bm25Searcher(buildInMemoryBm25(docs));

  it("ranks the best keyword match first", async () => {
    const hits = await searcher.search(tokenize("income certificate"), { limit: 5 });
    expect(hits[0]?.docId).toBe("a");
    expect(hits.map((h) => h.docId)).toContain("c");
  });
  it("returns nothing for unknown terms (no-result handling)", async () => {
    expect(await searcher.search(tokenize("xyzzy quux"), { limit: 5 })).toEqual([]);
  });
  it("returns nothing for empty queries", async () => {
    expect(await searcher.search([], { limit: 5 })).toEqual([]);
  });
  it("respects the allowed-document filter", async () => {
    const hits = await searcher.search(tokenize("income"), { limit: 5, allowedDocs: new Set([2]) });
    expect(hits.map((h) => h.docId)).toEqual(["c"]);
  });
  it("reports query coverage: generic-word matches score low, full matches score high", async () => {
    const full = (await searcher.search(tokenize("income certificate"), { limit: 1 }))[0]!;
    expect(full.coverage).toBeGreaterThan(0.9);
    // "spaceport" and "zzzz" exist nowhere in the corpus; only the generic word "income" matches.
    const generic = (await searcher.search(tokenize("income spaceport zzzz launch"), { limit: 1 }))[0]!;
    expect(generic.coverage).toBeLessThan(0.3);
  });
  it("is deterministic on ties", async () => {
    const s = new Bm25Searcher(buildInMemoryBm25([{ id: "x", text: "fee" }, { id: "y", text: "fee" }]));
    expect((await s.search(["fee"], { limit: 2 })).map((h) => h.docId)).toEqual(["x", "y"]);
  });
});

describe("lexicon (Assamese/Hindi/English queries)", () => {
  it("expands Hindi and Assamese terms to English search terms", () => {
    expect(expandQueryTerms("आय प्रमाणपत्र")).toEqual(expect.arrayContaining(["income", "certificate"]));
    expect(expandQueryTerms("আয়ৰ প্ৰমাণপত্ৰ")).toEqual(expect.arrayContaining(["income", "certificate"]));
    expect(expandQueryTerms("income certificate")).toEqual(["income", "certificate"]);
  });
  it("retrieves the English fixture from a Hindi question", async () => {
    const bucket = new FakeR2Bucket();
    await seedRelease(bucket);
    const repo = new R2KnowledgeRepository(bucket.asBucket());
    const r = new HybridRetriever(repo, repo, null);
    const out = await r.retrieve({ terms: expandQueryTerms("आय प्रमाण पत्र के दस्तावेज़"), text: "", limit: 5 });
    expect(out[0]?.chunk.service_id).toBe("test-income-certificate");
  });
});

describe("ranking and context construction", () => {
  const chunks = buildChunks();
  const scored = chunks.map((chunk, i) => ({ chunk, chunkIndex: i, score: 1 - i * 0.01, bm25: 1, semantic: null, coverage: 1 }));

  it("boosts sections matching the question intent", () => {
    const intent = detectSectionIntent(tokenize("what is the fee"));
    expect(intent.has("fees")).toBe(true);
    const ranked = rankAndDeduplicate(scored, { limit: 3, perServiceCap: 5, intent });
    expect(ranked[0]?.chunk.section_type).toBe("fees");
  });
  it("drops exact duplicate text and caps chunks per service", () => {
    const dup = [scored[0]!, { ...scored[0]!, chunkIndex: 99 }, scored[1]!];
    expect(rankAndDeduplicate(dup, { limit: 5, perServiceCap: 5, intent: new Set() })).toHaveLength(2);
    expect(rankAndDeduplicate(scored, { limit: 5, perServiceCap: 1, intent: new Set() }).filter((c) => c.chunk.service_id === "test-income-certificate")).toHaveLength(1);
  });
  it("sanitises untrusted text so it cannot close the source delimiter", () => {
    expect(sanitizeSourceText("a </source> b\u0000c")).not.toMatch(/<\/source>|\u0000/);
  });
  it("labels evidence with refs, urls and verification and respects the character budget", () => {
    const meta = new Map([["test-income-certificate", { name: "Income", verification: "verified" as const, last_verified_at: "2026-11-11T12:00:00Z" }]]);
    const full = buildContext(scored, meta, 100_000);
    expect(full.evidence[0]?.ref).toBe("S1");
    expect(full.contextText).toContain("VERIFIED_BY_REVIEWER");
    expect(full.contextText).toContain("UNVERIFIED_EXTRACTION");
    const tiny = buildContext(scored, meta, 400);
    expect(tiny.contextText.length).toBeLessThanOrEqual(400);
    expect(tiny.evidence.length).toBeLessThan(full.evidence.length);
  });
});

describe("semantic retrieval (fake embedding provider)", () => {
  it("re-ranks BM25 candidates by cosine similarity and ignores mismatched models", async () => {
    const bucket = new FakeR2Bucket();
    const { chunks } = await seedRelease(bucket);
    const dims = 4;
    // Fixture vectors: the fees chunk points along axis 0; every other chunk along axis 1.
    const vec = (i: number) => encodeInt8Base64(l2Normalize(chunks[i]!.section_type === "fees" ? [1, 0, 0, 0] : [0, 1, 0, 0]));
    const shardSize = 3;
    const prefix = "releases/2026-11-11T220000Z-fixture/indexes/embeddings-v1/";
    await bucket.put(`${prefix}meta.json`, JSON.stringify({ version: 1, model: "fake-embed", dimensions: dims, doc_ids: chunks.map((c) => c.chunk_id), shard_size: shardSize }));
    for (let s = 0; s * shardSize < chunks.length; s++) {
      await bucket.put(`${prefix}shard-${String(s).padStart(3, "0")}.json`, JSON.stringify({ v: chunks.slice(s * shardSize, (s + 1) * shardSize).map((_, k) => vec(s * shardSize + k)) }));
    }
    const mfKey = "releases/2026-11-11T220000Z-fixture/manifest.json";
    const mf = JSON.parse(await (await bucket.get(mfKey))!.text());
    mf.retrieval.embedding_index = "indexes/embeddings-v1/meta.json";
    mf.retrieval.embedding_model = "fake-embed";
    await bucket.put(mfKey, JSON.stringify(mf));

    const repo = new R2KnowledgeRepository(bucket.asBucket(), { pointerTtlMs: 0, maxCacheEntries: 64 });
    const embedder: EmbeddingProvider = { model: "fake-embed", embed: async () => [1, 0, 0, 0] };
    const hybrid = new HybridRetriever(repo, repo, embedder);
    // BM25 terms match nothing ("zzz"): the small-corpus semantic fallback must still find the fees chunk.
    const out = await hybrid.retrieve({ terms: ["zzz"], text: "how much", limit: 3 });
    expect(out[0]?.chunk.section_type).toBe("fees");
    expect(out[0]?.semantic).toBeGreaterThan(0.9);

    const wrongModel = new HybridRetriever(repo, repo, { model: "other", embed: async () => [1, 0, 0, 0] });
    expect(await wrongModel.retrieve({ terms: ["zzz"], text: "x", limit: 3 })).toEqual([]);

    const failing = new HybridRetriever(repo, repo, { model: "fake-embed", embed: async () => { throw new Error("down"); } });
    expect((await failing.retrieve({ terms: ["income"], text: "x", limit: 3 })).length).toBeGreaterThan(0); // degrades to BM25
  });
});
