# MCP server documentation

The Worker exposes a **read-only, stateless remote MCP server** at `/mcp` using **Streamable HTTP**.
Implementation: [`worker/mcp/`](worker/mcp) — `@modelcontextprotocol/server` v2 (`McpServer`) served through the Agents SDK
stateless `createMcpHandler` (`agents/mcp/server`). No Durable Objects, no sessions: a fresh server is built per request.

* Every tool is a thin adapter over the **same application use cases** as the REST API (`CatalogService`, `FactsService`,
  `SearchService`); there is no second copy of retrieval or business rules.
* Inputs are validated by strict Zod schemas with bounded limits. Domain failures (unknown/hidden service, …) are returned as
  tool results with `isError: true` and `{ error: { code, message } }`.
* Every fact result carries `status` (`published` / `not_published`), `verification` (`verified` / `unverified`), `sources`
  (URL, title, section, retrieved/verified dates), `last_verified_at`, `knowledge_release` and an explanatory `notice`.
  **`not_published` means unknown — clients must not guess fees, documents, eligibility or timelines.**
* No administrative operation (ingestion, review, upload, rebuild, rollback) and no application submission exists as an MCP tool.
  A test asserts the exact tool list and that all tools advertise `readOnlyHint: true`.
* Public access with per-client rate limiting (60 requests/min per isolate — add a Cloudflare WAF rate-limit rule for global enforcement).
  `Origin`/`Host` validation is performed by the handler (localhost and `workers.dev` by default).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `search_services` | `query`, `category?`, `department?`, `limit` (1–20, default 10) | ranked service ids, names, departments, verification |
| `get_service_details` | `service_id` | full published record, availability map, release |
| `get_eligibility` | `service_id` | eligibility + rejection conditions, or `not_published` |
| `get_required_documents` | `service_id`, `applicant_category?` | `{mandatory, conditional, optional, unspecified}` with verbatim conditions |
| `get_application_steps` | `service_id` | numbered steps, application URL, official page URL |
| `get_service_fees` | `service_id` | itemised fees with conditions/units, or `not_published` |
| `get_processing_timeline` | `service_id` | official timeline text/value, or `not_published` |
| `get_appeal_procedure` | `service_id` | appeal + grievance statements, or `not_published` |
| `search_guidelines` | `query`, `department?`, `limit` (1–10, default 5) | ranked official passages with source citation |
| `get_department_services` | `department_id` | services of a department |
| `get_source_document` | `source_id` | public source metadata (URL, title, hash, dates) |
| `get_knowledge_version` | — | active release id, counts, semantic-search availability |

Resources: `sewasetu://catalog/services` (first page), `sewasetu://catalog/departments`, `sewasetu://knowledge/version`.

## Connecting a client

* **MCP Inspector** (spec acceptance test — *not yet run*, see TESTING.md):
  ```bash
  npx @modelcontextprotocol/inspector
  # Transport: Streamable HTTP   URL: https://<your-worker>/mcp   (local: http://localhost:5173/mcp)
  ```
* **Claude Code**: `claude mcp add --transport http sewasetu https://<your-worker>/mcp`
* **Claude Desktop / other clients without native HTTP support**: use the `mcp-remote` bridge:
  ```json
  { "mcpServers": { "sewasetu": { "command": "npx", "args": ["mcp-remote", "https://<your-worker>/mcp"] } } }
  ```
* **curl** (raw JSON-RPC):
  ```bash
  curl -s https://<your-worker>/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
  ```
Opening `/mcp` in a browser does not show a web page; it is a JSON-RPC endpoint.

## Tested

`tests/mcp.test.ts` drives the real `/mcp` route with JSON-RPC requests (initialize, tools/list, tools/call for every tool,
resources/list|read, validation errors, hidden services, rate limiting) against the in-memory fixture release.
`scripts/mcp-client-check.ts` (`npm run mcp:check -- http://localhost:5173/mcp`) connects with the **official MCP client SDK** (`@modelcontextprotocol/client`, Streamable HTTP) to the Worker running in the local workerd runtime and lists tools/resources and calls tools; it passed against a local run with the real 919-service release.
**Not done:** MCP Inspector and a client talking to a *deployed* `workers.dev` URL (no Cloudflare credentials) — listed in the manual checklist.
