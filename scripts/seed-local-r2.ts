/**
 * Loads a locally built release (python ingestion output) into the LOCAL R2 emulation used by
 * `npm run dev`, so the app can be tried without any Cloudflare account.
 *   npx tsx scripts/seed-local-r2.ts build/release
 * Uses wrangler's getPlatformProxy so the objects land in the same persisted state directory
 * (.wrangler/state/v3: the Vite plugin appends "v3" itself, getPlatformProxy does not) that the Vite dev server reads. It never touches real Cloudflare resources.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getPlatformProxy } from "wrangler";

const dir = process.argv[2] ?? "build/release";
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));

const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const { env, dispose } = await getPlatformProxy<{ KNOWLEDGE_BUCKET: R2Bucket }>({ configPath: "wrangler.jsonc", persist: { path: ".wrangler/state/v3" } });
const bucket = env.KNOWLEDGE_BUCKET;

const files = walk(dir);
for (const f of files) await bucket.put(`releases/${manifest.release_id}/${relative(dir, f)}`, readFileSync(f));
// The pointer goes last, exactly like the production publisher.
await bucket.put("current.json", JSON.stringify({ release_id: manifest.release_id, published_at: new Date().toISOString(), schema_version: manifest.schema_version }));
console.log(`Seeded ${files.length} objects for release ${manifest.release_id} into local R2.`);
await dispose();
