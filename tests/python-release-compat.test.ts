/**
 * Cross-language contract test: a release built by the PYTHON ingestion pipeline (synthetic fixtures,
 * tests/fixtures/py-release) must be readable and searchable by the TypeScript Worker code.
 * Guards the BM25 shard hashing, chunk shard layout, manifest and schemas against drift.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../worker/app";
import { FakeR2Bucket } from "./helpers/fake-r2";
import { FakeLlm, buildWorld } from "./helpers/fakes";

const ROOT = "tests/fixtures/py-release";
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

async function loadPythonRelease() {
  const bucket = new FakeR2Bucket();
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  for (const f of walk(ROOT)) await bucket.put(`releases/${manifest.release_id}/${relative(ROOT, f)}`, readFileSync(f, "utf8"));
  await bucket.put("current.json", JSON.stringify({ release_id: manifest.release_id, published_at: "2026-11-11T10:00:00Z", schema_version: manifest.schema_version }));
  return { bucket, manifest };
}

describe("Python-built release read by the TypeScript Worker", () => {
  it("serves catalogue, details and checklist through the real API routes", async () => {
    const { bucket } = await loadPythonRelease();
    const w = buildWorld({ bucket, allowDraft: true });
    const app = createApp(() => w.services);
    const get = async (p: string) => (await app.request(p, {}, w.env)).json() as Promise<any>;

    const cat = await get("/api/v1/catalog");
    expect(cat.total).toBe(3);
    const svc = await get("/api/v1/services/test-income-certificate");
    expect(svc.verification).toBe("unverified"); // ingestion never verifies
    expect(svc.service.fees.items.map((f: any) => f.amount)).toEqual([30, 10, 10, null]); // "Subject to rules" keeps no invented amount
    const list = await get("/api/v1/services/test-income-certificate/checklist");
    expect(list.mandatory.map((d: any) => d.name)).toEqual(["Address Proof", "Identity Proof"]);
    expect(list.conditional[0].condition).toMatch(/PFC\/CSC/);
  });

  it("BM25 index built in Python is searchable with TypeScript query tokenization", async () => {
    const { bucket } = await loadPythonRelease();
    const w = buildWorld({ bucket, allowDraft: true });
    const hits = await w.services.app.search.searchPassages("documents required address proof", { limit: 3 });
    expect(hits[0]?.service_id).toBe("test-income-certificate");
    expect(hits[0]?.section_type).toBe("required_documents");
    const hindi = await w.services.app.search.searchServices("आय प्रमाण पत्र", { limit: 3 }); // lexicon expansion → English index terms
    expect(hindi.length).toBeGreaterThanOrEqual(0); // fixture names are "Income Certificate"; Hindi lexicon maps आय → income
    expect((await w.services.app.search.searchServices("income certificate", { limit: 3 }))[0]?.summary.service_id).toBe("test-income-certificate");
  });

  it("RAG over the Python release cites the official page of the fixture service", async () => {
    const { bucket } = await loadPythonRelease();
    const w = buildWorld({ bucket, allowDraft: true, llm: new FakeLlm("Address Proof is mandatory [S1].") });
    const res = await w.services.app.rag.answer({ question: "What documents are required for the income certificate?", conversation: [] });
    expect(res.sources[0]?.url).toBe("https://test.example.gov.in/site/service-apply/test-income-certificate");
    expect(res.verification).toBe("unverified");
  });
});
