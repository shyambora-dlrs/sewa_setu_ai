/**
 * Cloudflare Worker entrypoint.
 *
 *  - fetch:     Hono app (REST API, MCP, health). Static assets are served by the
 *               platform for every path not listed in `assets.run_worker_first`.
 *  - scheduled: daily freshness probe (cron in wrangler.jsonc). It only *observes*
 *               and logs; heavy ingestion runs in GitHub Actions.
 */
import { createApp } from "./app";
import type { AppEnv } from "./env";
import { buildServices } from "./services";

const app = createApp(buildServices);

export default {
  fetch: app.fetch,

  /** Logs a structured warning when the active release is missing or stale (visible in Workers Logs). */
  async scheduled(_event: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const s = buildServices(env);
        try {
          const v = await s.app.catalog.version();
          const ageHours = (s.now().getTime() - new Date(v.published_at).getTime()) / 3_600_000;
          const stale = ageHours > s.staleAfterHours;
          console.log(JSON.stringify({ level: stale ? "warn" : "info", event: "knowledge_freshness", release_id: v.release_id, age_hours: Math.round(ageHours), stale }));
        } catch (err) {
          console.error(JSON.stringify({ level: "error", event: "knowledge_unavailable", message: (err as Error).message }));
        }
      })(),
    );
  },
} satisfies ExportedHandler<AppEnv>;
