/**
 * Post-deploy / local smoke test against a running instance (spec step 8).
 *   npx tsx scripts/local-smoke-test.ts http://localhost:5173
 *   npx tsx scripts/local-smoke-test.ts https://sewasetu-ai.<subdomain>.workers.dev
 * It only performs read-only requests. The chat check is skipped unless --chat is passed
 * (it calls Groq and therefore needs the secret to be configured on the target).
 */
export {}; // makes this file an ES module so top-level await is allowed
const base = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");
const withChat = process.argv.includes("--chat");
let failed = 0;

async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}: ${(e as Error).message}`); }
}
const json = async (path: string, init?: RequestInit) => {
  const r = await fetch(base + path, init);
  return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
};
const expect = (c: unknown, m: string) => { if (!c) throw new Error(m); };

await step("GET / returns the SPA", async () => {
  const r = await fetch(base + "/"); expect(r.ok && (await r.text()).includes('<div id="root">'), "no SPA shell");
});
await step("SPA fallback for client routes", async () => { expect((await fetch(base + "/services/anything")).ok, "route not served"); });
await step("GET /health", async () => { const r = await json("/health"); expect(r.status === 200 && r.body.status === "ok", "unhealthy"); expect(r.body.knowledge.available, "no knowledge release published"); });
let firstId = "";
await step("GET /api/v1/catalog", async () => { const r = await json("/api/v1/catalog?page_size=3"); expect(r.status === 200 && r.body.total >= 0, "bad catalog"); firstId = r.body.items[0]?.service_id ?? ""; });
await step("GET /api/v1/search?q=land", async () => { const r = await json("/api/v1/search?q=land"); expect(r.status === 200 && Array.isArray(r.body.services), "bad search"); });
await step("GET service details + checklist", async () => {
  if (!firstId) return;
  expect((await json(`/api/v1/services/${firstId}`)).status === 200, "service"); expect((await json(`/api/v1/services/${firstId}/checklist`)).status === 200, "checklist");
});
await step("unknown service -> structured 404", async () => { const r = await json("/api/v1/services/does-not-exist"); expect(r.status === 404 && r.body.error.code === "not_found", "not a structured 404"); });
await step("admin routes reject anonymous access", async () => { expect((await json("/api/v1/admin/services")).status === 401, "admin is open!"); });
await step("GET /api/v1/system/version", async () => { expect((await json("/api/v1/system/version")).body.release_id, "no release id"); });
await step("MCP: initialize + tools/list", async () => {
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const r = await fetch(base + "/mcp", { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const t = await r.text(); expect(r.ok && t.includes("search_services") && !/ingest|upload|approve/.test(t), "tools missing or admin tool exposed");
});
if (withChat) {
  await step("POST /api/v1/chat (calls Groq)", async () => {
    const r = await json("/api/v1/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "What documents are required for an income certificate?", language: "en" }) });
    expect(r.status === 200 && r.body.answer && Array.isArray(r.body.sources), `chat failed (${r.status})`);
  });
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
