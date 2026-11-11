import { beforeAll, describe, expect, it } from "vitest";
import { authenticateAdmin, timingSafeEqual, verifyAccessJwt } from "../worker/middleware/access-auth";
import type { AppEnv } from "../worker/env";
import { createApp } from "../worker/app";
import { seedRelease } from "./helpers/fixture-release";
import { buildWorld } from "./helpers/fakes";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-123";
const b64 = (b: ArrayBuffer | string) => {
  const s = typeof b === "string" ? btoa(unescape(encodeURIComponent(b))) : btoa(String.fromCharCode(...new Uint8Array(b)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let keys: CryptoKeyPair;
let jwks: { keys: (JsonWebKey & { kid: string })[] };
beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...pub, kid: "k1", alg: "RS256" }] };
});

async function sign(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "k1" }, key = keys.privateKey) {
  const h = b64(JSON.stringify(header)), p = b64(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64(sig)}`;
}
const fetchJwks = (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch;
const NOW = 1_800_000_000_000;
const good = { iss: `https://${TEAM}`, aud: [AUD], email: "Admin@Example.com", exp: NOW / 1000 + 600, nbf: NOW / 1000 - 10 };
const cfg = { team: TEAM, aud: AUD };

describe("Cloudflare Access JWT verification", () => {
  it("accepts a valid token and lower-cases the email", async () => {
    expect(await verifyAccessJwt(await sign(good), cfg, fetchJwks, NOW)).toBe("admin@example.com");
  });
  it.each([
    ["expired", { ...good, exp: NOW / 1000 - 5 }],
    ["wrong audience", { ...good, aud: ["other"] }],
    ["wrong issuer", { ...good, iss: "https://evil.example.com" }],
    ["not yet valid", { ...good, nbf: NOW / 1000 + 3600 }],
    ["missing email", { ...good, email: undefined }],
  ])("rejects %s tokens", async (_n, claims) => {
    await expect(verifyAccessJwt(await sign(claims), cfg, fetchJwks, NOW)).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("rejects alg=none, unknown kid, bad signature and garbage", async () => {
    await expect(verifyAccessJwt(`${b64('{"alg":"none"}')}.${b64(JSON.stringify(good))}.`, cfg, fetchJwks, NOW)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyAccessJwt(await sign(good, { alg: "RS256", kid: "zzz" }), cfg, fetchJwks, NOW)).rejects.toMatchObject({ code: "unauthorized" });
    const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
    await expect(verifyAccessJwt(await sign(good, undefined, other.privateKey), cfg, fetchJwks, NOW)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(verifyAccessJwt("a.b", cfg, fetchJwks, NOW)).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("authenticateAdmin", () => {
  const base = { ADMIN_EMAILS: "", CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "" } as AppEnv;
  const req = (h: Record<string, string>) => new Request("https://x/api/v1/admin/me", { headers: h });

  it("fails closed when no mechanism is configured", async () => {
    await expect(authenticateAdmin(req({}), base)).rejects.toMatchObject({ code: "not_configured" });
  });
  it("accepts the bearer token and rejects wrong/missing tokens", async () => {
    const env = { ...base, ADMIN_API_TOKEN: "s3cret-token" };
    expect((await authenticateAdmin(req({ authorization: "Bearer s3cret-token" }), env)).method).toBe("token");
    await expect(authenticateAdmin(req({ authorization: "Bearer nope" }), env)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(authenticateAdmin(req({}), env)).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("enforces the ADMIN_EMAILS allowlist for Access identities", async () => {
    const env = { ...base, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, ADMIN_EMAILS: "admin@example.com" };
    const token = await sign(good);
    expect((await authenticateAdmin(req({ "cf-access-jwt-assertion": token }), env, { fetchImpl: fetchJwks, nowMs: NOW })).id).toBe("admin@example.com");
    await expect(authenticateAdmin(req({ "cf-access-jwt-assertion": token }), { ...env, ADMIN_EMAILS: "someone@else.org" }, { fetchImpl: fetchJwks, nowMs: NOW })).rejects.toMatchObject({ code: "forbidden" });
  });
  it("compares secrets in constant time semantics", async () => {
    expect(await timingSafeEqual("abc", "abc")).toBe(true);
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
    expect(await timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("admin routes require authentication", () => {
  it("returns 401 without credentials and never serves admin data", async () => {
    const w = buildWorld();
    await seedRelease(w.bucket);
    const app = createApp(() => w.services);
    for (const [method, path] of [["GET", "/api/v1/admin/services"], ["GET", "/api/v1/admin/me"], ["POST", "/api/v1/admin/rebuild"], ["POST", "/api/v1/admin/uploads"], ["PUT", "/api/v1/admin/services/test-trade-licence/review"]] as const) {
      const res = await app.request(path, { method }, w.env);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    const bad = await app.request("/api/v1/admin/services", { headers: { authorization: "Bearer wrong" } }, w.env);
    expect(bad.status).toBe(401);
  });
});
