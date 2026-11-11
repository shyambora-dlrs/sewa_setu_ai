/**
 * Post-retrieval ranking: section-intent boosting, de-duplication and diversity.
 */
import type { SectionType } from "../shared/schemas";
import type { ScoredChunk } from "./types";

/** Maps question vocabulary (post-tokenization, incl. lexicon expansions) to the section it targets. */
const INTENT_TERMS: Record<Exclude<SectionType, "general">, string[]> = {
  required_documents: ["document", "proof", "enclose", "upload", "certificate", "attach"],
  fees: ["fee", "charge", "cost", "pay", "payment", "price", "rs", "rupee"],
  steps: ["step", "procedure", "process", "apply", "application", "how"],
  eligibility: ["eligible", "eligibility", "qualify", "criterion", "criteria"],
  timeline: ["time", "days", "long", "duration", "timeline", "deadline", "delivery"],
  appeal: ["appeal", "appellate"],
  grievance: ["grievance", "complaint", "redressal"],
};

/** Detects which sections the question is about. */
export function detectSectionIntent(terms: string[]): Set<SectionType> {
  const set = new Set(terms);
  const out = new Set<SectionType>();
  for (const [section, words] of Object.entries(INTENT_TERMS)) {
    if (words.some((w) => set.has(w))) out.add(section as SectionType);
  }
  return out;
}

export interface RankOptions {
  limit: number;
  /** Max chunks from one service so a verbose service cannot crowd out others. */
  perServiceCap: number;
  intent: Set<SectionType>;
}

/** Normalises text for duplicate detection (case/whitespace insensitive). */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Re-orders retrieved chunks and trims them to the final evidence set.
 *  - boosts chunks from sections matching the question intent (x1.35)
 *  - drops exact duplicates (same text across services/documents)
 *  - caps chunks per service to keep multiple candidate services represented
 */
export function rankAndDeduplicate(chunks: ScoredChunk[], opts: RankOptions): ScoredChunk[] {
  const boosted = chunks
    .map((c) => ({ ...c, score: opts.intent.has(c.chunk.section_type) ? c.score * 1.35 : c.score }))
    .sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);

  const seen = new Set<string>();
  const perService = new Map<string, number>();
  const out: ScoredChunk[] = [];
  for (const c of boosted) {
    const key = dedupeKey(c.chunk.text);
    if (seen.has(key)) continue;
    const svc = c.chunk.service_id ?? "__general__";
    const used = perService.get(svc) ?? 0;
    if (used >= opts.perServiceCap) continue;
    seen.add(key);
    perService.set(svc, used + 1);
    out.push(c);
    if (out.length >= opts.limit) break;
  }
  return out;
}
