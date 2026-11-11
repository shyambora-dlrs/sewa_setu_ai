/**
 * Interop check with the OFFICIAL MCP client SDK over real HTTP (not our own JSON-RPC helper).
 *   npx tsx scripts/mcp-client-check.ts http://localhost:5173/mcp
 * Connects with Streamable HTTP, lists tools/resources and calls a few read-only tools.
 * This is a scripted client check, not a substitute for MCP Inspector.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = new URL(process.argv[2] ?? "http://localhost:5173/mcp");
const client = new Client({ name: "sewasetu-mcp-check", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(url));

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
const resources = await client.listResources();
console.log("resources:", resources.resources.map((r) => r.uri).join(", "));

const search: any = await client.callTool({ name: "search_services", arguments: { query: "income certificate", limit: 2 } });
const first = search.structuredContent.results[0];
console.log("search_services ->", first.service_id, first.verification);
const docs: any = await client.callTool({ name: "get_required_documents", arguments: { service_id: first.service_id } });
console.log("get_required_documents ->", docs.structuredContent.status, "groups:", Object.keys(docs.structuredContent.data).join("/"), "| sources:", docs.structuredContent.sources.length);
const missing: any = await client.callTool({ name: "get_service_fees", arguments: { service_id: "does-not-exist" } });
console.log("unknown service -> isError:", missing.isError, missing.structuredContent?.error?.code);
const res = await client.readResource({ uri: "sewasetu://knowledge/version" });
console.log("resource version ->", JSON.parse((res.contents[0] as any).text).release_id);
await client.close();
