/**
 * Exports the Zod schemas in packages/shared/schemas.ts to JSON Schema files in
 * knowledge-schemas/. The Python validator checks every release against these
 * files, so the Worker and the ingestion pipeline share ONE contract.
 * Run: npx tsx scripts/export-schemas.ts   (CI checks the files are up to date)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import * as S from "../packages/shared/schemas";

const out: Record<string, z.ZodType> = {
  "service.schema.json": S.Service,
  "service-summary.schema.json": S.ServiceSummary,
  "chunk.schema.json": S.Chunk,
  "manifest.schema.json": S.Manifest,
  "current.schema.json": S.CurrentPointer,
  "bm25-meta.schema.json": S.Bm25Meta,
  "embedding-meta.schema.json": S.EmbeddingMeta,
  "review-state.schema.json": S.ReviewState,
  "service-override.schema.json": S.ServiceOverride,
  "uploaded-document.schema.json": S.UploadedDocument,
};

mkdirSync("knowledge-schemas", { recursive: true });
for (const [file, schema] of Object.entries(out)) {
  const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" });
  writeFileSync(`knowledge-schemas/${file}`, JSON.stringify(json, null, 2) + "\n");
}
console.log(`wrote ${Object.keys(out).length} schemas`);
