/**
 * Unicode-aware tokenizer shared by indexing and querying.
 *
 * BM25 only works when the query is tokenized EXACTLY like the indexed text.
 * The index is built by Python (ingestion/.../tokenizer.py) and queried here, so
 * both implementations follow the same documented rules and read the same
 * `knowledge-schemas/tokenizer.json`. A cross-language fixture test
 * (tests/tokenizer.test.ts + ingestion/tests/test_tokenizer.py) guards parity.
 *
 * Rules:
 *  1. Unicode NFKC normalisation, then lower-casing.
 *  2. A token is a maximal run of letters (L*), combining marks (M*) or digits (N*).
 *     Marks must be kept: Assamese/Hindi vowel signs are category M.
 *  3. Light English plural folding ("certificates" -> "certificate", "fees" -> "fee")
 *     applied to pure ASCII tokens only. No stemming for Indic scripts.
 *  4. Tokens shorter than the minimum length (except digits) and stopwords are dropped.
 */
import tokenizerConfig from "../../knowledge-schemas/tokenizer.json";

const STOPWORDS = new Set<string>(tokenizerConfig.stopwords);
const MIN_LEN = tokenizerConfig.min_token_length;
const TOKEN_RE = /[\p{L}\p{M}\p{N}]+/gu;
const ASCII_WORD = /^[a-z]+$/;

/** Folds simple English plurals so singular/plural forms share one index term. */
export function foldPlural(token: string): string {
  if (!ASCII_WORD.test(token)) return token;
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Splits text into normalised index/query tokens (duplicates preserved for tf counting). */
export function tokenize(text: string): string[] {
  const normalised = text.normalize("NFKC").toLowerCase();
  const out: string[] = [];
  for (const match of normalised.matchAll(TOKEN_RE)) {
    const folded = foldPlural(match[0]);
    const isDigits = /^\p{N}+$/u.test(folded);
    if (folded.length < MIN_LEN && !isDigits) continue;
    if (STOPWORDS.has(folded)) continue;
    out.push(folded);
  }
  return out;
}

/**
 * 32-bit FNV-1a hash of the UTF-8 bytes of a term. Used to assign a term to a
 * posting shard; implemented identically in Python so both sides agree.
 */
export function fnv1a32(term: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(term)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export const BM25_DEFAULTS = tokenizerConfig.bm25;
