/**
 * Administrator API (/api/v1/admin/*). Every route is behind `requireAdmin`.
 *
 * Capabilities: browse/search extracted services (including drafts), inspect
 * sources, approve/reject (single and bulk), propose evidence-backed metadata
 * corrections, upload official PDFs, view ingestion logs, trigger a rebuild
 * (GitHub Actions) and roll the active release back.
 *
 * Extraction is never auto-verified: only an explicit reviewer decision marks a
 * record `verified`, and that decision is bound to the record's content hash.
 */
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { AppError, ValidationError } from "../../packages/domain/errors";
import { catalogQuerySchema, serviceIdSchema } from "../../packages/application/dto";
import { LIMITS } from "../../packages/shared/constants";
import { ServiceOverride, type ReviewDecision } from "../../packages/shared/schemas";
import { parseWith, readJson } from "../http";
import type { HonoEnv } from "../types";

export const adminRoutes = new Hono<HonoEnv>();

/** Authenticates every admin request; stores the identity for audit fields. */
export const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  c.set("admin", await c.var.services.authenticate(c.req.raw));
  c.header("cache-control", "no-store");
  await next();
};
adminRoutes.use("*", requireAdmin);

adminRoutes.get("/me", (c) => c.json({ identity: c.var.admin!.id, method: c.var.admin!.method }));

const listQuery = catalogQuerySchema.extend({
  status: z.enum(["draft", "verified", "rejected"]).optional(),
  has_warnings: z.enum(["true", "false"]).optional(),
});

adminRoutes.get("/services", async (c) => {
  const q = parseWith(listQuery, c.req.query());
  const { adminCatalog, search } = c.var.services.app;
  // The admin catalogue shows everything (drafts and rejected included).
  const full = await adminCatalog.list({ ...q, page: 1, page_size: 10_000, q: undefined });
  let items = full.items;
  if (q.status) items = items.filter((s) => s.publication_status === q.status);
  if (q.has_warnings) items = items.filter((s) => (s.warning_count > 0) === (q.has_warnings === "true"));
  if (q.category) items = items.filter((s) => s.category === q.category);
  if (q.department) items = items.filter((s) => s.department_id === q.department || s.department_name === q.department);
  if (q.q) {
    const needle = q.q.toLowerCase();
    items = items.filter((s) => s.service_name.toLowerCase().includes(needle) || s.service_id.includes(needle));
  }
  void search;
  const total = items.length;
  const start = (q.page - 1) * q.page_size;
  const counts = { draft: 0, verified: 0, rejected: 0 };
  for (const s of full.items) counts[s.publication_status]++;
  return c.json({
    items: items.slice(start, start + q.page_size),
    page: q.page, page_size: q.page_size, total, total_pages: Math.max(1, Math.ceil(total / q.page_size)),
    status_counts: counts, facets: full.facets, knowledge_release: full.knowledge_release,
  });
});

adminRoutes.get("/services/:serviceId", async (c) => {
  const id = parseWith(serviceIdSchema, c.req.param("serviceId"));
  const { adminCatalog } = c.var.services.app;
  const [detail, review, override] = await Promise.all([
    adminCatalog.getWithMeta(id),
    c.var.services.admin.get(),
    c.var.services.admin.getOverride(id),
  ]);
  return c.json({ ...detail, review: review.decisions[id] ?? null, pending_override: override });
});

const reviewBody = z.object({
  decision: z.enum(["approve", "reject", "reset"]),
  notes: z.string().trim().max(2000).optional(),
});

adminRoutes.put("/services/:serviceId/review", async (c) => {
  const id = parseWith(serviceIdSchema, c.req.param("serviceId"));
  const body = parseWith(reviewBody, await readJson(c));
  const s = c.var.services;
  const service = await s.app.adminCatalog.get(id);
  const decision: ReviewDecision | null =
    body.decision === "reset"
      ? null
      : {
          decision: body.decision === "approve" ? "approved" : "rejected",
          // Bound to the exact content reviewed: if the source changes, approval goes stale.
          content_hash: service.content_hash,
          reviewer: c.var.admin!.id,
          reviewed_at: s.now().toISOString(),
          notes: body.notes ?? null,
        };
  await s.admin.applyDecisions({ [id]: decision });
  return c.json({ service_id: id, decision: decision?.decision ?? "reset" });
});

const bulkBody = z.object({
  service_ids: z.array(serviceIdSchema).min(1).max(200),
  decision: z.enum(["approve", "reject", "reset"]),
  notes: z.string().trim().max(2000).optional(),
});

adminRoutes.post("/reviews/bulk", async (c) => {
  const body = parseWith(bulkBody, await readJson(c));
  const s = c.var.services;
  const changes: Record<string, ReviewDecision | null> = {};
  const missing: string[] = [];
  for (const id of body.service_ids) {
    let service;
    try { service = await s.app.adminCatalog.get(id); } catch { missing.push(id); continue; }
    changes[id] = body.decision === "reset" ? null : {
      decision: body.decision === "approve" ? "approved" : "rejected",
      content_hash: service.content_hash,
      reviewer: c.var.admin!.id,
      reviewed_at: s.now().toISOString(),
      notes: body.notes ?? null,
    };
  }
  await s.admin.applyDecisions(changes);
  return c.json({ updated: Object.keys(changes).length, missing });
});

/** Evidence-backed corrections. Stored as an override and applied at the next rebuild. */
adminRoutes.put("/services/:serviceId/metadata", async (c) => {
  const id = parseWith(serviceIdSchema, c.req.param("serviceId"));
  const raw = (await readJson(c)) as Record<string, unknown>;
  const s = c.var.services;
  await s.app.adminCatalog.get(id); // 404 for unknown services
  const override = parseWith(ServiceOverride, {
    ...raw, service_id: id, updated_by: c.var.admin!.id, updated_at: s.now().toISOString(),
  });
  if (Object.keys(override.patch).length === 0) throw new ValidationError("The patch must change at least one field.");
  await s.admin.putOverride(override);
  return c.json({ saved: true, note: "The correction will be applied when the knowledge index is rebuilt." });
});

adminRoutes.get("/uploads", async (c) => c.json({ uploads: await c.var.services.admin.listUploads() }));

/** Multipart PDF upload: fields `file`, `title`, `origin` (required), `department`, `service_id`. */
adminRoutes.post("/uploads", async (c) => {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > LIMITS.adminUploadBytes + 64 * 1024) throw new AppError("payload_too_large", "Upload is too large.");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("A PDF file is required in the 'file' field.");
  const meta = parseWith(
    z.object({
      title: z.string().trim().min(3).max(300),
      origin: z.string().trim().min(3).max(500),
      department: z.string().trim().max(200).optional(),
      service_id: serviceIdSchema.optional(),
    }),
    { title: form.get("title"), origin: form.get("origin"), department: form.get("department") || undefined, service_id: form.get("service_id") || undefined },
  );
  const doc = await c.var.services.admin.putUpload(await file.arrayBuffer(), {
    filename: file.name.slice(0, 200), title: meta.title, origin: meta.origin,
    department: meta.department ?? null, service_id: meta.service_id ?? null, uploaded_by: c.var.admin!.id,
  });
  return c.json({ upload: doc, note: "The PDF will be extracted at the next rebuild." }, 201);
});

adminRoutes.get("/feedback", async (c) => c.json({ items: await c.var.services.admin.listFeedback() }));

adminRoutes.get("/ingestion/logs", async (c) => {
  const limit = parseWith(z.coerce.number().int().min(1).max(25).default(10), c.req.query("limit"));
  return c.json({ releases: await c.var.services.releases.listReleases(limit) });
});

adminRoutes.post("/rebuild", async (c) => c.json(await c.var.services.dispatchRebuild(), 202));

adminRoutes.post("/releases/activate", async (c) => {
  const { release_id } = parseWith(z.object({ release_id: z.string().min(6).max(90) }), await readJson(c));
  const pointer = await c.var.services.releases.activate(release_id);
  return c.json({ active: pointer });
});

