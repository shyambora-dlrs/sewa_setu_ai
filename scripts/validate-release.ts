/**
 * Validates a release directory with the SAME Zod schemas the Worker uses to read it.
 * This is the cross-language contract test: Python produces the release, TypeScript proves
 * the Worker can parse every record. Usage: npx tsx scripts/validate-release.ts build/release
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Bm25Meta, Chunk, Manifest, Service, ServiceSummary, SourceRef } from "../packages/shared/schemas";

const dir = process.argv[2] ?? "build/release";
const read = (p: string) => JSON.parse(readFileSync(join(dir, p), "utf8"));
const errors: string[] = [];
const check = (label: string, r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => {
  if (!r.success) errors.push(`${label}: ${r.error!.issues.slice(0, 2).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
};

const manifest = Manifest.parse(read("manifest.json"));
for (const f of readdirSync(join(dir, "catalog/services"))) check(`service ${f}`, Service.safeParse(read(`catalog/services/${f}`)));
for (const s of read("catalog/summaries.json")) check(`summary ${s.service_id}`, ServiceSummary.safeParse(s));
for (const f of readdirSync(join(dir, "chunks"))) for (const c of read(`chunks/${f}`)) check(`chunk ${c.chunk_id}`, Chunk.safeParse(c));
for (const [id, s] of Object.entries(read("catalog/sources.json"))) check(`source ${id}`, SourceRef.safeParse(s));
check("bm25 meta", Bm25Meta.safeParse(read(manifest.retrieval.keyword_index)));

if (errors.length) {
  console.error(`${errors.length} schema error(s):\n` + errors.slice(0, 20).join("\n"));
  process.exit(1);
}
console.log(`OK: release ${manifest.release_id} - ${manifest.service_count} services, ${manifest.chunk_count} chunks parse with the Worker's Zod schemas`);
