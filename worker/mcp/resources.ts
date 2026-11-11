/** Read-only MCP resources (sewasetu://...). */
import type { McpServer } from "@modelcontextprotocol/server";
import type { Application } from "../../packages/application/container";

export function registerResources(server: McpServer, app: Application): void {
  const json = (uri: URL, data: unknown) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data) }] });

  server.registerResource(
    "services-catalog",
    "sewasetu://catalog/services",
    { title: "Service catalogue", description: "First page (50) of published service summaries.", mimeType: "application/json" },
    async (uri) => {
      const r = await app.catalog.list({ page: 1, page_size: 50 });
      return json(uri, { total: r.total, note: "Use search_services for ranked lookup. First page shown.", services: r.items });
    },
  );
  server.registerResource(
    "departments-catalog",
    "sewasetu://catalog/departments",
    { title: "Departments", description: "Departments with published services.", mimeType: "application/json" },
    async (uri) => json(uri, { departments: await app.catalog.departments() }),
  );
  server.registerResource(
    "knowledge-version",
    "sewasetu://knowledge/version",
    { title: "Knowledge release", description: "Active knowledge release metadata.", mimeType: "application/json" },
    async (uri) => json(uri, await app.catalog.version()),
  );
}
