/**
 * Read-only MCP tools exposing service knowledge. Each tool is a thin adapter over
 * the SAME application use cases used by the REST API (spec: no duplicated logic).
 * Inputs are validated by strict Zod schemas with bounded limits; every result
 * carries source URLs, verification state and an explicit not-published status.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Application } from "../../../packages/application/container";
import type { FactSection } from "../../../packages/application/facts-service";
import { serviceIdSchema } from "../../../packages/application/dto";
import { guarded, READ_ONLY } from "./helpers";

const serviceId = serviceIdSchema.describe("Service id as returned by search_services, e.g. 'application-for-income-certificate'");

export function registerServiceTools(server: McpServer, app: Application): void {
  server.registerTool(
    "search_services",
    {
      title: "Search Sewa Setu services",
      description: "Find Assam government services by keyword (English, Assamese or Hindi). Returns service ids, departments and verification status.",
      inputSchema: z.object({
        query: z.string().trim().min(2).max(200),
        category: z.string().trim().max(100).optional(),
        department: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, category, department, limit }) =>
      guarded(async () => {
        const hits = await app.search.searchServices(query, { limit, category, department });
        return {
          query,
          count: hits.length,
          results: hits.map((h) => ({
            service_id: h.summary.service_id,
            service_name: h.summary.service_name,
            department: h.summary.department_name,
            category: h.summary.category,
            verification: h.summary.publication_status === "verified" ? "verified" : "unverified",
            score: Number(h.score.toFixed(4)),
          })),
        };
      }),
  );

  server.registerTool(
    "get_service_details",
    {
      title: "Get complete service details",
      description: "Full published record for one service, including sources and which sections are published.",
      inputSchema: z.object({ service_id: serviceId }),
      annotations: READ_ONLY,
    },
    async ({ service_id }) => guarded(async () => ({ ...(await app.catalog.getWithMeta(service_id)) })),
  );

  /** Registers a facet tool backed by FactsService. */
  const facet = (name: string, title: string, description: string, section: FactSection, extra?: z.ZodRawShape) =>
    server.registerTool(
      name,
      { title, description, inputSchema: z.object({ service_id: serviceId, ...(extra ?? {}) }), annotations: READ_ONLY },
      async (args: { service_id: string; applicant_category?: string }) =>
        guarded(async () => ({ ...(await app.facts.get(args.service_id, section, { applicantCategory: args.applicant_category })) })),
    );

  facet("get_eligibility", "Get eligibility requirements", "Published eligibility conditions. status='not_published' means the official source states none.", "eligibility");
  facet(
    "get_required_documents",
    "Get required documents",
    "Document checklist split into mandatory, conditional and optional items, with the original source wording.",
    "required_documents",
    { applicant_category: z.string().trim().max(100).optional() },
  );
  facet("get_application_steps", "Get application steps", "Step-by-step application instructions and the official application URL.", "application_steps");
  facet("get_service_fees", "Get service fees", "Published fees/charges with conditions, or an explicit not_published status. Fees are never estimated.", "fees");
  facet("get_processing_timeline", "Get processing timeline", "Official processing time, or an explicit not_published status. Timelines are never estimated.", "processing_time");
  facet("get_appeal_procedure", "Get appeal and grievance procedure", "Published appeal/grievance procedure for the service.", "appeal_procedure");

  server.registerTool(
    "search_guidelines",
    {
      title: "Search official guideline passages",
      description: "Retrieve the most relevant official passages (with source URL, section and verification status) for a question.",
      inputSchema: z.object({
        query: z.string().trim().min(2).max(300),
        department: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(10).default(5),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, department, limit }) =>
      guarded(async () => ({ query, passages: await app.search.searchPassages(query, { limit, department }) })),
  );

  server.registerTool(
    "get_department_services",
    {
      title: "List a department's services",
      description: "Services published for a department id (see sewasetu://catalog/departments).",
      inputSchema: z.object({ department_id: z.string().trim().min(1).max(200) }),
      annotations: READ_ONLY,
    },
    async ({ department_id }) =>
      guarded(async () => {
        const services = await app.catalog.departmentServices(department_id);
        return { department_id, count: services.length, services: services.map((s) => ({ service_id: s.service_id, service_name: s.service_name, category: s.category })) };
      }),
  );

  server.registerTool(
    "get_source_document",
    {
      title: "Get source document metadata",
      description: "Public metadata (URL, title, retrieval date, hash) for a source id found in other tool results.",
      inputSchema: z.object({ source_id: z.string().trim().regex(/^[A-Za-z0-9_.-]{1,120}$/) }),
      annotations: READ_ONLY,
    },
    async ({ source_id }) => guarded(async () => ({ source: await app.catalog.source(source_id) })),
  );

  server.registerTool(
    "get_knowledge_version",
    {
      title: "Get knowledge release version",
      description: "Active knowledge release id, publication time and counts.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => guarded(async () => ({ ...(await app.catalog.version()) })),
  );
}
