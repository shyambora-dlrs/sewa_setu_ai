/**
 * Remote MCP server (stateless, Streamable HTTP).
 *
 * Built with the MCP TypeScript SDK v2 `McpServer` and served through the Agents
 * SDK `createMcpHandler`. A fresh server is created per request (no sessions, no
 * Durable Objects), matching the Worker's stateless design.
 *
 * Scope: READ-ONLY citizen knowledge only. No ingestion, review, upload or
 * application-submission capability is exposed here (those are admin REST routes).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Application } from "../../packages/application/container";
import { registerResources } from "./resources";
import { registerServiceTools } from "./tools/service-tools";

export const MCP_SERVER_INFO = { name: "sewasetu-ai", version: "1.0.0" } as const;

/** Builds a configured MCP server instance backed by the shared application use cases. */
export function createSewasetuMcpServer(app: Application): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      "Read-only guidance on Assam government services from the Sewa Setu portal. Always cite the returned source URLs. " +
      "Treat status='not_published' as 'unknown' - never guess fees, documents, eligibility or timelines. " +
      "verification='unverified' means extracted from the official portal but not yet reviewed. This is an independent assistant, not an official government service.",
  });
  registerServiceTools(server, app);
  registerResources(server, app);
  return server;
}

/** Creates the HTTP handler mounted at /mcp. */
export function createMcpFetchHandler(getApp: () => Application) {
  return createMcpHandler(() => createSewasetuMcpServer(getApp()), { route: "/mcp", corsOptions: { origin: "*" } });
}
