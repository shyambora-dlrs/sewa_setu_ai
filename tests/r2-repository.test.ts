import { describe, expect, it } from "vitest";
import { KnowledgeUnavailableError } from "../packages/domain/errors";
import { R2KnowledgeRepository } from "../worker/adapters/r2-knowledge-repository";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { RELEASE_ID, seedRelease } from "./helpers/fixture-release";

describe("R2KnowledgeRepository", () => {
  it("reports 'knowledge unavailable' before the first release", async () => {
    const repo = new R2KnowledgeRepository(new FakeR2Bucket().asBucket());
    await expect(repo.getRelease()).rejects.toBeInstanceOf(KnowledgeUnavailableError);
  });

  it("resolves current.json -> manifest and reads summaries/services/chunks", async () => {
    const bucket = new FakeR2Bucket();
    await seedRelease(bucket);
    const repo = new R2KnowledgeRepository(bucket.asBucket());
    expect((await repo.getRelease()).pointer.release_id).toBe(RELEASE_ID);
    expect(await repo.listSummaries()).toHaveLength(3);
    expect((await repo.getService("test-income-certificate"))?.fees.status).toBe("published");
    const chunks = await repo.getChunksByIndex([0, 3, 99]);
    expect(chunks[0]?.chunk_id).toBeTruthy();
    expect(chunks[1]?.chunk_id).toBeTruthy();
    expect(chunks[2]).toBeNull(); // out-of-range index is a hole, not a crash
  });

  it("returns null for unknown or malicious service ids without building arbitrary keys", async () => {
    const bucket = new FakeR2Bucket();
    await seedRelease(bucket);
    const repo = new R2KnowledgeRepository(bucket.asBucket());
    expect(await repo.getService("nope")).toBeNull();
    bucket.reads.length = 0;
    expect(await repo.getService("../../admin/review-state")).toBeNull();
    expect(bucket.reads.some((k) => k.includes("admin"))).toBe(false);
  });

  it("reports corrupt or missing release objects as knowledge-unavailable", async () => {
    const bucket = new FakeR2Bucket();
    await seedRelease(bucket);
    bucket.store.delete(`releases/${RELEASE_ID}/catalog/summaries.json`);
    const repo = new R2KnowledgeRepository(bucket.asBucket());
    await expect(repo.listSummaries()).rejects.toBeInstanceOf(KnowledgeUnavailableError);
    await bucket.put("current.json", "not json");
    await expect(new R2KnowledgeRepository(bucket.asBucket()).getRelease()).rejects.toBeInstanceOf(KnowledgeUnavailableError);
  });

  it("caches immutable objects per release and picks up a new release after the pointer TTL", async () => {
    const bucket = new FakeR2Bucket();
    await seedRelease(bucket, "2026-11-11T220000Z-aaaaaa");
    let t = 0;
    const repo = new R2KnowledgeRepository(bucket.asBucket(), { pointerTtlMs: 1000, maxCacheEntries: 64 }, () => t);
    await repo.listSummaries();
    bucket.reads.length = 0;
    await repo.listSummaries();
    expect(bucket.reads.filter((k) => k.endsWith("summaries.json"))).toHaveLength(0); // served from cache

    await seedRelease(bucket, "2026-11-12T220000Z-bbbbbb"); // publishes and flips current.json
    expect((await repo.getRelease()).pointer.release_id).toBe("2026-11-11T220000Z-aaaaaa"); // pointer still cached
    t = 2000;
    expect((await repo.getRelease()).pointer.release_id).toBe("2026-11-12T220000Z-bbbbbb");
    bucket.reads.length = 0;
    await repo.listSummaries();
    expect(bucket.reads.some((k) => k.includes("bbbbbb") && k.endsWith("summaries.json"))).toBe(true); // cache key includes release id
  });
});
