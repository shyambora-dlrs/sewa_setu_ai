/**
 * Builds the evidence context sent to the LLM.
 *
 * Each retrieved chunk becomes a numbered source block `[S1]`, `[S2]`... carrying
 * its official URL, section and verification status. The model must cite these
 * ids; `validateCitations` later checks it cited only ids that exist.
 *
 * Security: chunk text comes from scraped web pages/PDFs and is UNTRUSTED. It is
 * sanitised (control characters removed, angle brackets escaped so it cannot
 * close our delimiters) and wrapped in <source> tags that the system prompt
 * declares to be data, never instructions.
 */
import type { VerificationLevel } from "../domain/visibility";
import type { ScoredChunk } from "./types";

export interface EvidenceItem {
  /** Citation handle used in the answer, e.g. "S1". */
  ref: string;
  chunk_id: string;
  service_id: string | null;
  service_name: string | null;
  section_type: string;
  text: string;
  source_url: string;
  source_title: string;
  page_or_section: string | null;
  retrieved_at: string;
  last_verified_at: string | null;
  verification: VerificationLevel;
}

export interface BuiltContext {
  evidence: EvidenceItem[];
  /** Prompt-ready text of all source blocks. */
  contextText: string;
}

/** Strips control characters and neutralises markup in untrusted source text. */
export function sanitizeSourceText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export interface ServiceMeta {
  name: string;
  verification: VerificationLevel;
  last_verified_at: string | null;
}

/**
 * Packs ranked chunks into the context window budget (characters).
 * Chunks that would overflow the budget are skipped, not truncated, so a
 * requirement is never cut in half.
 */
export function buildContext(
  ranked: ScoredChunk[],
  serviceMeta: ReadonlyMap<string, ServiceMeta>,
  maxChars: number,
): BuiltContext {
  const evidence: EvidenceItem[] = [];
  const blocks: string[] = [];
  let used = 0;

  for (const { chunk } of ranked) {
    const meta = chunk.service_id ? serviceMeta.get(chunk.service_id) : undefined;
    const ref = `S${evidence.length + 1}`;
    const text = sanitizeSourceText(chunk.text);
    const status = meta?.verification ?? "unverified";
    const header =
      `<source id="${ref}" service="${sanitizeSourceText(meta?.name ?? "general")}" ` +
      `section="${chunk.section_type}" status="${status === "verified" ? "VERIFIED_BY_REVIEWER" : "UNVERIFIED_EXTRACTION"}" ` +
      `url="${chunk.source_url}">`;
    const block = `${header}\n${text}\n</source>`;
    if (used + block.length > maxChars) continue;
    used += block.length;
    blocks.push(block);
    evidence.push({
      ref,
      chunk_id: chunk.chunk_id,
      service_id: chunk.service_id,
      service_name: meta?.name ?? null,
      section_type: chunk.section_type,
      text: chunk.text,
      source_url: chunk.source_url,
      source_title: chunk.source_title,
      page_or_section: chunk.page_or_section,
      retrieved_at: chunk.retrieved_at,
      last_verified_at: meta?.last_verified_at ?? null,
      verification: status,
    });
  }
  return { evidence, contextText: blocks.join("\n\n") };
}
