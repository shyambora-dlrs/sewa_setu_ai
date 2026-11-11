/**
 * HTTP application: middleware pipeline + route mounting.
 *
 * `createApp(buildServices)` receives a factory so production (R2/Groq) and tests
 * (in-memory fakes) share exactly the same routes, middleware and error handling.
 *
 * Request pipeline:
 *   request-id -> security headers -> (per-route) rate limit -> controller -> error envelope
 */
import { Hono } from "hono";
import { createMcpFetchHandler } from "./mcp/create-server";
import { createRateLimiter } from "./middleware/rate-limit";
import { errorResponse } from "./http";
import { adminRoutes } from "./routes/admin.routes";
import { chatRoutes } from "./routes/chat.routes";
import { feedbackRoutes } from "./routes/feedback.routes";
import { healthRoutes } from "./routes/health.routes";
import { serviceRoutes } from "./routes/services.routes";
import type { AppEnv } from "./env";
import type { HonoEnv, Services } from "./types";

export type ServicesFactory = (env: AppEnv) => Services;

export interface RateLimits { chat: number; read: number; mcp: number; admin: number; feedback?: number }
export const DEFAULT_LIMITS: RateLimits = { chat: 20, read: 120, mcp: 60, admin: 120, feedback: 10 };

export function createApp(buildServices: ServicesFactory, limits: RateLimits = DEFAULT_LIMITS) {
  const app = new Hono<HonoEnv>();

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.set("services", buildServices(c.env));
    await next();
    // Defence-in-depth headers for API/JSON responses (HTML headers live in apps/web/public/_headers).
    c.header("x-request-id", c.get("requestId"));
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
  });

  app.route("/", healthRoutes);

  // Rate limiters are created once per app instance (one isolate) - see rate-limit.ts caveats.
  const readLimit = createRateLimiter("read", limits.read);
  const chatLimit = createRateLimiter("chat", limits.chat);
  const adminLimit = createRateLimiter("admin", limits.admin);
  const mcpLimit = createRateLimiter("mcp", limits.mcp);

  app.use("/api/v1/chat", chatLimit);
  app.use("/api/v1/admin/*", adminLimit);
  app.use("/api/v1/feedback", createRateLimiter("feedback", limits.feedback ?? 10));
  app.use("/api/v1/catalog", readLimit);
  app.use("/api/v1/services/*", readLimit);
  app.use("/api/v1/search", readLimit);
  app.use("/api/v1/departments", readLimit);
  app.use("/api/v1/sources/*", readLimit);

  app.route("/api/v1", chatRoutes);
  app.route("/api/v1", feedbackRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1", serviceRoutes);

  // MCP: one stateless handler per isolate; the application container is resolved per request.
  app.all("/mcp", mcpLimit, (c) => createMcpFetchHandler(() => c.var.services.app).fetch(c.req.raw));

  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: { code: "not_found", message: "Unknown API route.", request_id: c.get("requestId") } }, 404)
      : c.text("Not found", 404),
  );
  app.onError((err, c) => errorResponse(c, err));
  return app;
}
