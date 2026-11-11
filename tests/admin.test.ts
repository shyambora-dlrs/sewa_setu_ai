import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../worker/app";
import { seedRelease, RELEASE_ID } from "./helpers/fixture-release";
import { buildWorld, type TestWorld } from "./helpers/fakes";
import { R2AdminStore } from "../worker/adapters/r2-admin-store";

let w: TestWorld;
let app: ReturnType<typeof createApp>;
const AUTH = { authorization: "Bearer test-admin-token-123" };
const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...AUTH, ...(init.headers as object) } }, w.env);
const json = (method: string, path: string, body: unknown) => call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(async () => {
  w = buildWorld({ allowDraft: false }); // production-like: citizens only see verified content
  await seedRelease(w.bucket);
  app = createApp(() => w.services);
});

describe("admin review workflow", () => {
  it("lists all services including drafts and rejected, with status counts and filters", async () => {
    const body = await (await call("/api/v1/admin/services")).json() as any;
    expect(body.total).toBe(3);
    expect(body.status_counts).toEqual({ draft: 1, verified: 1, rejected: 1 });
    const drafts = await (await call("/api/v1/admin/services?status=draft")).json() as any;
    expect(drafts.items.map((i: any) => i.service_id)).toEqual(["test-trade-licence"]);
    const search = await (await call("/api/v1/admin/services?q=jamabandi")).json() as any;
    expect(search.total).toBe(1);
  });

  it("drafts are invisible to citizens until approved, then become verified immediately", async () => {
    expect((await app.request("/api/v1/services/test-trade-licence", {}, w.env)).status).toBe(404);
    const res = await json("PUT", "/api/v1/admin/services/test-trade-licence/review", { decision: "approve", notes: "checked against portal" });
    expect(res.status).toBe(200);
    const pub = await (await app.request("/api/v1/services/test-trade-licence", {}, w.env)).json() as any;
    expect(pub.verification).toBe("verified");
    expect(pub.service.last_verified_at).toBeTruthy();
    const detail = await (await call("/api/v1/admin/services/test-trade-licence")).json() as any;
    expect(detail.review).toMatchObject({ decision: "approved", reviewer: "admin-token", notes: "checked against portal" });
  });

  it("a rejection hides a service; reset returns it to draft", async () => {
    await json("PUT", "/api/v1/admin/services/test-income-certificate/review", { decision: "reject" });
    expect((await app.request("/api/v1/services/test-income-certificate", {}, w.env)).status).toBe(404);
    await json("PUT", "/api/v1/admin/services/test-income-certificate/review", { decision: "reset" });
    // Back to the release's own status (verified in the fixture).
    expect((await app.request("/api/v1/services/test-income-certificate", {}, w.env)).status).toBe(200);
  });

  it("an approval goes stale when the source content hash changes (new release)", async () => {
    await json("PUT", "/api/v1/admin/services/test-trade-licence/review", { decision: "approve" });
    // Simulate re-ingestion: same service, new content hash.
    const key = `releases/${RELEASE_ID}/catalog/summaries.json`;
    const sums = JSON.parse(await (await w.bucket.get(key))!.text());
    sums.find((s: any) => s.service_id === "test-trade-licence").content_hash = "changed-hash-0002";
    await w.bucket.put(key, JSON.stringify(sums));
    const svcKey = `releases/${RELEASE_ID}/catalog/services/test-trade-licence.json`;
    const svc = JSON.parse(await (await w.bucket.get(svcKey))!.text());
    svc.content_hash = "changed-hash-0002";
    await w.bucket.put(svcKey, JSON.stringify(svc));
    expect((await app.request("/api/v1/services/test-trade-licence", {}, w.env)).status).toBe(404);
  });

  it("supports bulk decisions and reports unknown ids", async () => {
    const res = await json("POST", "/api/v1/admin/reviews/bulk", { service_ids: ["test-trade-licence", "ghost"], decision: "approve" });
    expect(await res.json()).toEqual({ updated: 1, missing: ["ghost"] });
  });

  it("validates review bodies and unknown services", async () => {
    expect((await json("PUT", "/api/v1/admin/services/test-trade-licence/review", { decision: "maybe" })).status).toBe(400);
    expect((await json("PUT", "/api/v1/admin/services/ghost/review", { decision: "approve" })).status).toBe(404);
  });

  it("does not lose concurrent review updates (optimistic locking)", async () => {
    const store = new R2AdminStore(w.bucket.asBucket(), () => new Date("2026-11-12T00:00:00Z"), 0);
    const d = (id: string) => ({ decision: "approved" as const, content_hash: "h", reviewer: "r", reviewed_at: "2026-11-12T00:00:00Z", notes: null, id });
    await Promise.all([store.applyDecisions({ a: d("a") }), store.applyDecisions({ b: d("b") }), store.applyDecisions({ c: d("c") })]);
    expect(Object.keys((await store.get()).decisions).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("admin metadata, uploads and releases", () => {
  it("accepts evidence-backed overrides and rejects ones without evidence or changes", async () => {
    const good = await json("PUT", "/api/v1/admin/services/test-trade-licence/metadata", {
      evidence: { source_url: "https://test.example.gov.in/guideline.pdf", note: "Section 4 of guideline" }, patch: { designated_authority: "Circle Officer" },
    });
    expect(good.status).toBe(200);
    expect(await w.services.admin.getOverride("test-trade-licence")).toMatchObject({ patch: { designated_authority: "Circle Officer" } });
    expect((await json("PUT", "/api/v1/admin/services/test-trade-licence/metadata", { patch: { designated_authority: "x" } })).status).toBe(400);
    expect((await json("PUT", "/api/v1/admin/services/test-trade-licence/metadata", { evidence: { source_url: "https://a.b/c", note: "ok ok" }, patch: {} })).status).toBe(400);
  });

  const form = (file: Blob | string, name = "g.pdf", extra: Record<string, string> = { title: "Trade licence guideline", origin: "https://dept.example.gov.in/g.pdf" }) => {
    const f = new FormData();
    f.set("file", typeof file === "string" ? file : new File([file], name));
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return f;
  };

  it("stores a real PDF content-addressed and lists it", async () => {
    const pdf = new Blob(["%PDF-1.7\n%test"], { type: "application/pdf" });
    const res = await call("/api/v1/admin/uploads", { method: "POST", body: form(pdf) });
    expect(res.status).toBe(201);
    const { upload } = await res.json() as any;
    expect(w.bucket.store.has(`admin/uploads/${upload.sha256}.pdf`)).toBe(true);
    await call("/api/v1/admin/uploads", { method: "POST", body: form(pdf) }); // idempotent
    expect(((await (await call("/api/v1/admin/uploads")).json()) as any).uploads).toHaveLength(1);
  });

  it("rejects non-PDF content regardless of filename, empty files and missing metadata", async () => {
    const fake = await call("/api/v1/admin/uploads", { method: "POST", body: form(new Blob(["MZ not a pdf"]), "evil.pdf") });
    expect(fake.status).toBe(400);
    expect((await call("/api/v1/admin/uploads", { method: "POST", body: form(new Blob([]), "e.pdf") })).status).toBe(400);
    expect((await call("/api/v1/admin/uploads", { method: "POST", body: form(new Blob(["%PDF-1"]), "a.pdf", { title: "x" }) })).status).toBe(400);
    expect((await call("/api/v1/admin/uploads", { method: "POST", body: form("just text") })).status).toBe(400);
  });

  it("lists ingestion logs and activates (rolls back to) an earlier validated release", async () => {
    await w.bucket.put(`releases/${RELEASE_ID}/reports/extraction-report.json`, JSON.stringify({ totals: { failed: 2 } }));
    await seedRelease(w.bucket, "2026-11-12T220000Z-newer1");
    const logs = await (await call("/api/v1/admin/ingestion/logs")).json() as any;
    expect(logs.releases.map((r: any) => r.release_id)).toEqual(["2026-11-12T220000Z-newer1", RELEASE_ID]);
    expect(logs.releases[0].active).toBe(true);
    expect(logs.releases[1].report).toEqual({ totals: { failed: 2 } });

    const rb = await json("POST", "/api/v1/admin/releases/activate", { release_id: RELEASE_ID });
    expect(rb.status).toBe(200);
    expect(JSON.parse(await (await w.bucket.get("current.json"))!.text())).toMatchObject({ release_id: RELEASE_ID, previous_release_ids: ["2026-11-12T220000Z-newer1"] });
    expect((await json("POST", "/api/v1/admin/releases/activate", { release_id: "2020-01-01T000000Z-ghost0" })).status).toBe(404);
    expect((await json("POST", "/api/v1/admin/releases/activate", { release_id: "../../x" })).status).toBe(400);
  });

  it("refuses to activate a release that failed validation", async () => {
    const id = "2026-11-13T220000Z-failed";
    await seedRelease(w.bucket, id);
    const mk = `releases/${id}/manifest.json`;
    const m = JSON.parse(await (await w.bucket.get(mk))!.text());
    m.validation_status = "failed";
    await w.bucket.put(mk, JSON.stringify(m));
    await w.bucket.put("current.json", JSON.stringify({ release_id: RELEASE_ID, published_at: "2026-11-11T22:00:00Z", schema_version: "1.0.0" }));
    expect((await json("POST", "/api/v1/admin/releases/activate", { release_id: id })).status).toBe(400);
  });

  it("rebuild dispatch reports not-configured clearly", async () => {
    const real = (await import("../worker/adapters/github-dispatcher")).dispatchIngestion;
    await expect(real({ repo: "REPLACE_WITH_OWNER/REPO", workflow: "w.yml", token: undefined })).rejects.toMatchObject({ code: "not_configured" });
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await real({ repo: "o/r", workflow: "w.yml", token: "t", fetchImpl })).toEqual({ dispatched: true, workflow: "w.yml" });
    const res = await call("/api/v1/admin/rebuild", { method: "POST" });
    expect(res.status).toBe(202);
  });
});
