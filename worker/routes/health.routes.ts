/** Public health and version routes. Responses contain no secrets or internal object keys. */
import { Hono } from "hono";
import type { HonoEnv } from "../types";

export const healthRoutes = new Hono<HonoEnv>();

healthRoutes.get("/health", async (c) => {
  const s = c.var.services;
  let knowledge: Record<string, unknown> = { available: false };
  try {
    const v = await s.app.catalog.version();
    const ageHours = (s.now().getTime() - new Date(v.published_at).getTime()) / 3_600_000;
    knowledge = { available: true, release_id: v.release_id, published_at: v.published_at, age_hours: Math.round(ageHours), stale: ageHours > s.staleAfterHours };
  } catch {
    // Health must answer even before the first release exists.
  }
  c.header("cache-control", "no-store");
  return c.json({ status: "ok", env: c.env.APP_ENV, knowledge });
});
