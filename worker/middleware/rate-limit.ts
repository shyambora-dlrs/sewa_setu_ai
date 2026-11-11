/**
 * Fixed-window rate limiter keyed by client IP and route group.
 *
 * Limitation (documented in SECURITY.md): state lives in one isolate's memory,
 * so this is a best-effort abuse brake, not a global quota. Production should
 * also configure a Cloudflare WAF rate-limiting rule for /api/v1/chat and /mcp.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "../../packages/domain/errors";

interface Window { count: number; resetAt: number }

export function createRateLimiter(group: string, limit: number, windowMs = 60_000, now: () => number = Date.now): MiddlewareHandler {
  const windows = new Map<string, Window>();
  return async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const t = now();
    // Opportunistic cleanup keeps the map bounded without timers.
    if (windows.size > 5000) for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    const key = `${group}:${ip}`;
    let w = windows.get(key);
    if (!w || w.resetAt <= t) {
      w = { count: 0, resetAt: t + windowMs };
      windows.set(key, w);
    }
    w.count++;
    c.header("x-ratelimit-limit", String(limit));
    c.header("x-ratelimit-remaining", String(Math.max(0, limit - w.count)));
    if (w.count > limit) {
      c.header("retry-after", String(Math.ceil((w.resetAt - t) / 1000)));
      throw new AppError("rate_limited", "Too many requests. Please wait a moment and try again.", { retry_after_seconds: Math.ceil((w.resetAt - t) / 1000) });
    }
    await next();
  };
}
