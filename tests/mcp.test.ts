import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../worker/app";
import { seedRelease } from "./helpers/fixture-release";
import { buildWorld, type TestWorld } from "./helpers/fakes";

let w: TestWorld;
let app: ReturnType<typeof createApp>;
let id = 0;

/** Sends one JSON-RPC request to the stateless Streamable-HTTP endpoint and returns the parsed result. */
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  }, w.env);
  const text = await res.text();
  // The transport may answer with plain JSON or an SSE frame; support both.
  const payload = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).pop()!
    : text;
  return { status: res.status, body: JSON.parse(payload) };
}
const callTool = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).body.result;

beforeEach(async () => {
  w = buildWorld();
  await seedRelease(w.bucket);
  app = createApp(() => w.services);
});

describe("MCP endpoint (/mcp, stateless Streamable HTTP)", () => {
  it("initializes and advertises tools/resources", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } });
    expect(body.result.serverInfo.name).toBe("sewasetu-ai");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists exactly the read-only citizen tools (no admin/ingestion tools)", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      "get_application_steps", "get_appeal_procedure", "get_department_services", "get_eligibility", "get_knowledge_version",
      "get_processing_timeline", "get_required_documents", "get_service_details", "get_service_fees", "get_source_document",
      "search_guidelines", "search_services",
    ].sort());
    expect(names.some((n: string) => /ingest|upload|review|rebuild|approve|submit/.test(n))).toBe(false);
    for (const t of body.result.tools) expect(t.annotations?.readOnlyHint).toBe(true);
  });

  it("search_services returns ids and verification", async () => {
    const r = await callTool("search_services", { query: "income certificate", limit: 3 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.results[0]).toMatchObject({ service_id: "test-income-certificate", verification: "verified" });
  });

  it("get_required_documents separates mandatory / conditional / optional and cites sources", async () => {
    const r = (await callTool("get_required_documents", { service_id: "test-income-certificate" })).structuredContent;
    expect(r.status).toBe("published");
    expect(r.data.mandatory).toHaveLength(2);
    expect(r.data.conditional[0].condition).toMatch(/PFC\/CSC/);
    expect(r.data.optional[0].name).toBe("Salary Slip");
    expect(r.sources[0].url).toMatch(/^https:/);
    expect(r.knowledge_release).toBeTruthy();
  });

  it("returns an explicit not_published status instead of inventing fees/timelines", async () => {
    const fees = (await callTool("get_service_fees", { service_id: "test-trade-licence" })).structuredContent;
    expect(fees.status).toBe("not_published");
    expect(fees.data.amount).toBeNull();
    expect(fees.notice).toMatch(/not publish/i);
    const time = (await callTool("get_processing_timeline", { service_id: "test-income-certificate" })).structuredContent;
    expect(time.status).toBe("not_published");
    const fee = (await callTool("get_service_fees", { service_id: "test-income-certificate" })).structuredContent;
    expect(fee.data.items[0]).toMatchObject({ amount: 30 });
  });

  it("covers the remaining tools", async () => {
    expect((await callTool("get_service_details", { service_id: "test-income-certificate" })).structuredContent.service.service_id).toBe("test-income-certificate");
    expect((await callTool("get_application_steps", { service_id: "test-income-certificate" })).structuredContent.data.steps).toHaveLength(2);
    expect((await callTool("get_eligibility", { service_id: "test-income-certificate" })).structuredContent.status).toBe("not_published");
    expect((await callTool("get_appeal_procedure", { service_id: "test-income-certificate" })).structuredContent.status).toBe("not_published");
    expect((await callTool("search_guidelines", { query: "address proof", limit: 3 })).structuredContent.passages[0].source.url).toMatch(/^https/);
    expect((await callTool("get_department_services", { department_id: "test-revenue" })).structuredContent.count).toBe(1);
    expect((await callTool("get_source_document", { source_id: "src-test-income-certificate" })).structuredContent.source.source_url).toMatch(/^https/);
    expect((await callTool("get_knowledge_version", {})).structuredContent.release_id).toBe("2026-11-11T220000Z-fixture");
  });

  it("reports not-found and hidden services as tool errors, and validates inputs", async () => {
    const nf = await callTool("get_service_details", { service_id: "does-not-exist" });
    expect(nf.isError).toBe(true);
    expect(nf.structuredContent.error.code).toBe("not_found");
    expect((await callTool("get_service_details", { service_id: "test-land-record" })).isError).toBe(true); // rejected => hidden
    const bad = await rpc("tools/call", { name: "search_services", arguments: { query: "x", limit: 500 } });
    expect(bad.body.error || bad.body.result?.isError).toBeTruthy();
    const bad2 = await rpc("tools/call", { name: "get_service_details", arguments: { service_id: "../etc" } });
    expect(bad2.body.error || bad2.body.result?.isError).toBeTruthy();
  });

  it("serves read-only resources", async () => {
    const list = await rpc("resources/list");
    expect(list.body.result.resources.map((r: any) => r.uri).sort()).toEqual(["sewasetu://catalog/departments", "sewasetu://catalog/services", "sewasetu://knowledge/version"]);
    const read = await rpc("resources/read", { uri: "sewasetu://knowledge/version" });
    expect(JSON.parse(read.body.result.contents[0].text).release_id).toBe("2026-11-11T220000Z-fixture");
  });

  it("rate limits abusive clients", async () => {
    const limited = createApp(() => w.services, { chat: 10, read: 10, mcp: 1, admin: 10 });
    const send = () => limited.request("/mcp", { method: "POST", headers: { host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": "9.9.9.9" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }, w.env);
    await send();
    expect((await send()).status).toBe(429);
  });
});
