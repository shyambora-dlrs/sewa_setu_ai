/** Calibration helper: prints BM25 query coverage for sample questions against a local release directory. */
import { readFileSync } from "node:fs";
import { Bm25Searcher } from "../packages/retrieval/bm25";
import { expandQueryTerms } from "../packages/retrieval/lexicon";
const dir = process.argv[2] ?? "build/release";
const meta = JSON.parse(readFileSync(`${dir}/indexes/bm25-v1/meta.json`, "utf8"));
const src = { getMeta: async () => meta, getShard: async (n: number) => JSON.parse(readFileSync(`${dir}/indexes/bm25-v1/shard-${String(n).padStart(2, "0")}.json`, "utf8")) };
const s = new Bm25Searcher(src);
const qs = process.argv.slice(3);
for (const q of qs) {
  const hits = await s.search(expandQueryTerms(q), { limit: 3 });
  console.log(`${hits[0]?.coverage.toFixed(2) ?? "none"}  ${hits[0]?.score.toFixed(1) ?? ""}  ${q}`);
}
