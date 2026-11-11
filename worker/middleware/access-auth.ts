/**
 * Administrator authentication.
 *
 * Two mechanisms, evaluated in order (fail closed if neither is configured):
 *  1. Cloudflare Access: validates the `Cf-Access-Jwt-Assertion` JWT (RS256) against
 *     the team's JWKS, checking signature, `exp`/`nbf`, issuer and audience.
 *     The email claim must be in ADMIN_EMAILS when that allowlist is set.
 *     Always validate the JWT in the Worker: an Access policy in front of the
 *     route is not enough if the workers.dev hostname is reachable directly.
 *  2. A static bearer token (`ADMIN_API_TOKEN` secret) compared in constant time.
 *     Meant for local development, CI and as a fallback when Access isn't set up.
 */
import { AppError } from "../../packages/domain/errors";
import type { AppEnv } from "../env";

export interface AdminIdentity {
  id: string;
  method: "access" | "token";
}

type Jwk = JsonWebKey & { kid?: string };

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (s: string) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

/** Constant-time string comparison (via SHA-256 digests, so lengths don't leak either). */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** JWKS cache shared across requests in one isolate (keys rotate rarely). */
const jwksCache = new Map<string, { keys: Jwk[]; at: number }>();

async function getJwks(team: string, fetchImpl: typeof fetch, nowMs: number): Promise<Jwk[]> {
  const hit = jwksCache.get(team);
  if (hit && nowMs - hit.at < 10 * 60_000) return hit.keys;
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AppError("unauthorized", "Could not load Cloudflare Access signing keys.");
  const keys = ((await res.json()) as { keys: Jwk[] }).keys;
  jwksCache.set(team, { keys, at: nowMs });
  return keys;
}

/** Verifies an Access JWT and returns the authenticated email, or throws unauthorized. */
export async function verifyAccessJwt(
  token: string,
  cfg: { team: string; aud: string },
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<string> {
  const unauthorized = () => new AppError("unauthorized", "Invalid Cloudflare Access token.");
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized();
  let header: { alg?: string; kid?: string }, claims: Record<string, any>;
  try {
    header = b64urlJson(parts[0]!);
    claims = b64urlJson(parts[1]!);
  } catch {
    throw unauthorized();
  }
  if (header.alg !== "RS256") throw unauthorized(); // reject "none"/HS256 downgrade attacks

  const jwk = (await getJwks(cfg.team, fetchImpl, nowMs)).find((k) => k.kid === header.kid);
  if (!jwk) throw unauthorized();
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw unauthorized();

  const nowSec = Math.floor(nowMs / 1000);
  const aud: string[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (typeof claims.exp !== "number" || claims.exp < nowSec) throw unauthorized();
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + 30) throw unauthorized();
  if (claims.iss !== `https://${cfg.team}`) throw unauthorized();
  if (!aud.includes(cfg.aud)) throw unauthorized();
  if (typeof claims.email !== "string") throw unauthorized();
  return claims.email.toLowerCase();
}

/** Resolves the caller's admin identity from a request, or throws unauthorized/forbidden. */
export async function authenticateAdmin(
  req: Request,
  env: AppEnv,
  opts: { fetchImpl?: typeof fetch; nowMs?: number } = {},
): Promise<AdminIdentity> {
  const accessConfigured = Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
  const tokenConfigured = Boolean(env.ADMIN_API_TOKEN);
  if (!accessConfigured && !tokenConfigured) {
    throw new AppError("not_configured", "Admin access is not configured (set Cloudflare Access variables or ADMIN_API_TOKEN).");
  }

  const jwt = req.headers.get("cf-access-jwt-assertion");
  if (accessConfigured && jwt) {
    const email = await verifyAccessJwt(jwt, { team: env.CF_ACCESS_TEAM_DOMAIN, aud: env.CF_ACCESS_AUD }, opts.fetchImpl, opts.nowMs);
    const allow = env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (allow.length > 0 && !allow.includes(email)) throw new AppError("forbidden", "This account is not an authorised administrator.");
    return { id: email, method: "access" };
  }

  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (tokenConfigured && bearer && (await timingSafeEqual(bearer, env.ADMIN_API_TOKEN!))) {
    return { id: "admin-token", method: "token" };
  }
  throw new AppError("unauthorized", "Administrator authentication required.");
}
