/**
 * BM25 keyword retrieval over a *sharded inverted index*.
 *
 * Why sharded: the Worker must not load the whole corpus per request. Postings
 * are partitioned by FNV-1a(term) % shard_count, so a query touching N distinct
 * terms fetches at most N (usually far fewer) small shard files from R2.
 * Document lengths and ids live in a small meta file loaded once per release.
 *
 * The same searcher serves the in-memory catalogue index (built at request time
 * from ~600 short service names) and the on-disk chunk index (built by Python).
 */
import type { Bm25Meta, Bm25Shard } from "../shared/schemas";
import { BM25_DEFAULTS, fnv1a32, tokenize } from "../shared/tokenizer";

/** Where index files come from: R2 for chunks, memory for the catalogue. */
export interface Bm25Source {
  getMeta(): Promise<Bm25Meta>;
  getShard(shard: number): Promise<Bm25Shard>;
}

export interface Bm25Hit {
  docIndex: number;
  docId: string;
  score: number;
  /**
   * Share (0..1) of the query's total IDF mass that this document matches. Terms absent from the
   * whole corpus count with maximal weight, so a question about something the corpus does not
   * contain ("spaceport licence") scores low even when generic words like "licence" match.
   */
  coverage: number;
}

export interface Bm25SearchOptions {
  limit: number;
  /** Restrict scoring to these doc indices (service filter); null = whole corpus. */
  allowedDocs?: ReadonlySet<number> | null;
}

export class Bm25Searcher {
  constructor(private readonly source: Bm25Source) {}

  /**
   * Scores documents against already-tokenized query terms.
   * @param queryTerms tokens (use `tokenize()` / lexicon expansion upstream)
   * @returns hits sorted by descending score (ties broken by index for determinism)
   */
  async search(queryTerms: string[], opts: Bm25SearchOptions): Promise<Bm25Hit[]> {
    const terms = [...new Set(queryTerms)];
    if (terms.length === 0) return [];
    const meta = await this.source.getMeta();
    if (meta.doc_count === 0) return [];

    // Group terms by shard so each shard file is fetched exactly once.
    const byShard = new Map<number, string[]>();
    for (const term of terms) {
      const shard = fnv1a32(term) % meta.shard_count;
      byShard.set(shard, [...(byShard.get(shard) ?? []), term]);
    }
    const shardData = await Promise.all(
      [...byShard.keys()].map(async (n) => [n, await this.source.getShard(n)] as const),
    );
    const shardMap = new Map(shardData);

    const scores = new Map<number, number>();
    const matched = new Map<number, number>();
    let totalMass = 0;
    for (const term of terms) {
      const postings = shardMap.get(fnv1a32(term) % meta.shard_count)?.[term];
      if (!postings || postings.length === 0) {
        // Out-of-vocabulary Latin-script term: unmatched mass (capped so natural filler words such as
        // "much" or "lost" do not dominate). Non-Latin terms are ignored: the corpus is English, so an
        // untranslated Hindi/Assamese filler word can never match and must not count against the question.
        if (/^[\x00-\x7f]+$/.test(term)) totalMass += Math.min(3, Math.log(1 + (meta.doc_count + 0.5) / 0.5));
        continue;
      }
      const df = postings.length;
      // Lucene-style non-negative IDF: rare terms weigh more, never below zero.
      const idf = Math.log(1 + (meta.doc_count - df + 0.5) / (df + 0.5));
      totalMass += idf;
      for (const [docIndex, tf] of postings) {
        if (opts.allowedDocs && !opts.allowedDocs.has(docIndex)) continue;
        const dl = meta.doc_lens[docIndex] ?? meta.avg_doc_len;
        // Length-normalised term-frequency saturation (k1 controls saturation, b length penalty).
        const norm = tf + meta.k1 * (1 - meta.b + (meta.b * dl) / (meta.avg_doc_len || 1));
        const contribution = idf * ((tf * (meta.k1 + 1)) / norm);
        scores.set(docIndex, (scores.get(docIndex) ?? 0) + contribution);
        matched.set(docIndex, (matched.get(docIndex) ?? 0) + idf);
      }
    }

    return [...scores.entries()]
      .map(([docIndex, score]) => ({
        docIndex,
        docId: meta.doc_ids[docIndex]!,
        score,
        coverage: totalMass > 0 ? Math.min(1, (matched.get(docIndex) ?? 0) / totalMass) : 0,
      }))
      .sort((a, b) => b.score - a.score || a.docIndex - b.docIndex)
      .slice(0, opts.limit);
  }
}

/**
 * Builds an index entirely in memory (same data structures as the Python-built
 * on-disk index). Used for the service catalogue and for unit tests.
 */
export function buildInMemoryBm25(docs: { id: string; text: string }[]): Bm25Source {
  const shardCount = BM25_DEFAULTS.shard_count;
  const shards: Bm25Shard[] = Array.from({ length: shardCount }, () => ({}));
  const docLens: number[] = [];

  docs.forEach((doc, docIndex) => {
    const tokens = tokenize(doc.text);
    docLens.push(tokens.length);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      const shard = shards[fnv1a32(term) % shardCount]!;
      (shard[term] ??= []).push([docIndex, count]);
    }
  });

  const meta: Bm25Meta = {
    version: 1,
    k1: BM25_DEFAULTS.k1,
    b: BM25_DEFAULTS.b,
    doc_count: docs.length,
    avg_doc_len: docLens.length ? docLens.reduce((a, b) => a + b, 0) / docLens.length : 0,
    shard_count: shardCount,
    doc_ids: docs.map((d) => d.id),
    doc_lens: docLens,
  };
  return { getMeta: async () => meta, getShard: async (n) => shards[n] ?? {} };
}
