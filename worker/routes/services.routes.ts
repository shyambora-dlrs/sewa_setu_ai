/**
 * Public read-only catalogue routes (GET /api/v1/...). Thin controllers: they
 * validate input, call an application use case and shape the HTTP response.
 * No business logic lives here.
 */
import { Hono } from "hono";
import { z } from "zod";
import { catalogQuerySchema, searchQuerySchema, serviceIdSchema } from "../../packages/application/dto";
import { parseWith } from "../http";
import type { HonoEnv } from "../types";

export const serviceRoutes = new Hono<HonoEnv>();

/** Citizen content changes only on publish/review; a short shared cache protects R2 and the CPU budget. */
const cacheShort = (c: { header: (k: string, v: string) => void }) => c.header("cache-control", "public, max-age=30");

serviceRoutes.get("/catalog", async (c) => {
  const q = parseWith(catalogQuerySchema, c.req.query());
  const { catalog, search } = c.var.services.app;
  // When a text query is present, rank by BM25 instead of plain substring filtering.
  let matchIds: Set<string> | null = null;
  if (q.q) {
    const hits = await search.searchServices(q.q, { limit: 200, category: q.category, department: q.department });
    matchIds = new Set(hits.map((h) => h.summary.service_id));
    const result = await catalog.list({ ...q, q: undefined }, matchIds);
    // Preserve BM25 order for the matched page.
    const order = new Map(hits.map((h, i) => [h.summary.service_id, i]));
    result.items.sort((a, b) => (order.get(a.service_id) ?? 0) - (order.get(b.service_id) ?? 0));
    cacheShort(c);
    return c.json(result);
  }
  cacheShort(c);
  return c.json(await catalog.list(q));
});

serviceRoutes.get("/services/:serviceId", async (c) => {
  const id = parseWith(serviceIdSchema, c.req.param("serviceId"));
  cacheShort(c);
  return c.json(await c.var.services.app.catalog.getWithMeta(id));
});

serviceRoutes.get("/services/:serviceId/checklist", async (c) => {
  const id = parseWith(serviceIdSchema, c.req.param("serviceId"));
  const category = parseWith(z.string().max(100).optional(), c.req.query("applicant_category"));
  cacheShort(c);
  return c.json(await c.var.services.app.catalog.checklist(id, category));
});

serviceRoutes.get("/departments", async (c) => {
  cacheShort(c);
  return c.json({ departments: await c.var.services.app.catalog.departments() });
});

serviceRoutes.get("/search", async (c) => {
  const q = parseWith(searchQuerySchema, c.req.query());
  const { search } = c.var.services.app;
  const [services, passages] = await Promise.all([
    search.searchServices(q.q, { limit: q.limit, category: q.category, department: q.department }),
    search.searchPassages(q.q, { limit: Math.min(q.limit, 8), department: q.department }),
  ]);
  cacheShort(c);
  return c.json({ query: q.q, services, passages });
});

serviceRoutes.get("/sources/:sourceId", async (c) => {
  const id = parseWith(z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/), c.req.param("sourceId"));
  cacheShort(c);
  // Public source metadata only: no raw object key or stored file is ever exposed.
  return c.json(await c.var.services.app.catalog.source(id));
});

serviceRoutes.get("/system/version", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await c.var.services.app.catalog.version());
});
