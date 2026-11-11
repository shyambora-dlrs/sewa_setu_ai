/**
 * RAG use case: answers a citizen question using only retrieved official text.
 *
 * Pipeline (spec section 9):
 *   guard -> language -> (rewrite) -> resolve services -> retrieve (BM25[+semantic])
 *   -> rank/dedupe -> build context -> Groq -> validate citations -> respond
 *
 * Design choices:
 *  - If no evidence is retrieved the LLM is NOT called; a fixed, localized
 *    "cannot verify" answer is returned. This is the main anti-hallucination gate.
 *  - LLM failures degrade gracefully to "here are the relevant passages".
 *  - The service depends on ports only (LlmProvider, retriever, repositories).
 */
import { LIMITS, INDEPENDENT_DISCLAIMER, type Language } from "../shared/constants";
import { LlmError } from "../domain/errors";
import { MESSAGES, detectLanguage } from "../domain/language";
import type { KnowledgeRepository, LlmProvider } from "../domain/ports";
import { verificationLevel } from "../domain/visibility";
import { detectSectionIntent, rankAndDeduplicate } from "../retrieval/chunk-ranker";
import { buildContext, type EvidenceItem, type ServiceMeta } from "../retrieval/context-builder";
import { expandQueryTerms } from "../retrieval/lexicon";
import { tokenize } from "../shared/tokenizer";
import type { ChunkRetriever, ScoredChunk } from "../retrieval/types";
import type { VisibilityPolicy } from "./catalog-service";
import type { ChatAnswer, ChatRequest, SourceCitation } from "./dto";
import { guardQuestion } from "./guards";
import { buildMessages, buildRewriteMessages, validateCitations } from "./prompt";
import type { SearchService } from "./search-service";

export interface RagConfig {
  maxChunks: number;
  maxContextChars: number;
  maxOutputTokens: number;
  temperature: number;
  /** Ask the LLM to translate non-English questions into English search keywords. */
  queryRewrite: boolean;
  /** Catalogue score ratio (vs best hit) a service must reach to be treated as relevant. */
  serviceScoreRatio: number;
  /** Chunks matching less than this share of the question's term weight are discarded before the LLM call. */
  minCoverage: number;
  /** Stricter floor used when the LLM is unavailable and raw passages are shown instead. */
  degradedMinCoverage: number;
}

export const DEFAULT_RAG_CONFIG: RagConfig = {
  maxChunks: LIMITS.maxRetrievedChunks,
  maxContextChars: LIMITS.maxContextChars,
  maxOutputTokens: 1500,
  temperature: 0.1,
  queryRewrite: true,
  serviceScoreRatio: 0.55,
  minCoverage: 0.3,
  degradedMinCoverage: 0.5,
};

export class RagService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly search: SearchService,
    private readonly retriever: ChunkRetriever,
    private readonly llm: LlmProvider,
    private readonly visible: VisibilityPolicy,
    private readonly config: RagConfig = DEFAULT_RAG_CONFIG,
  ) {}

  async answer(req: ChatRequest): Promise<ChatAnswer> {
    const guard = guardQuestion(req.question);
    // Explicit language wins; otherwise infer from the script of the original question.
    const language: Language = req.language ?? detectLanguage(req.question);
    const { pointer } = await this.repo.getRelease();
    const base = { language, knowledge_release: pointer.release_id, disclaimer: INDEPENDENT_DISCLAIMER[language] };

    // Questions about a person's own application cannot be answered from public knowledge.
    if (guard.asksApplicationStatus) {
      return { ...base, answer: MESSAGES.statusRequest![language], verification: "unavailable", sources: [], related_services: [] };
    }
    // The question was only (or mostly) secrets: nothing meaningful is left to retrieve.
    const remainder = guard.sanitized.replace(/\[removed\]/g, "").trim();
    if (guard.hadSensitiveData && tokenize(remainder).length === 0) {
      return { ...base, answer: MESSAGES.sensitiveData![language], verification: "unavailable", sources: [], related_services: [] };
    }

    const summaries = new Map((await this.repo.listSummaries()).map((s) => [s.service_id, s]));
    if (req.service_id && !(summaries.has(req.service_id) && this.visible(summaries.get(req.service_id)!.publication_status))) {
      // An unknown/hidden service filter is treated as "no filter" rather than leaking existence.
      req = { ...req, service_id: undefined };
    }

    const question = guard.sanitized;
    // "[removed]" markers are for the LLM's benefit only; they must not pollute keyword retrieval.
    const searchable = question.replace(/\[removed\]/g, " ");
    const rewritten = await this.rewriteQuery(question, language);
    const terms = [...expandQueryTerms(searchable), ...(rewritten ? tokenize(rewritten) : [])];

    // 1. Which services is the question about? (explicit filter, or top catalogue matches)
    const relatedHits = req.service_id
      ? []
      : await this.search.searchServices(searchable, { limit: 5, extraTerms: rewritten ? tokenize(rewritten) : [] });
    const best = relatedHits[0]?.score ?? 0;
    const relevant = relatedHits.filter((h) => h.score >= best * this.config.serviceScoreRatio).slice(0, 3);
    const scopedIds = req.service_id ? [req.service_id] : relevant.map((h) => h.summary.service_id);

    // 2. Retrieve: scoped to the likely services first, plus a global pass to catch cross-service guidance.
    const retrievalText = rewritten ? `${searchable} ${rewritten}` : searchable;
    const [scoped, global] = await Promise.all([
      scopedIds.length ? this.retriever.retrieve({ terms, text: retrievalText, serviceIds: scopedIds, limit: this.config.maxChunks * 2 }) : Promise.resolve([]),
      req.service_id ? Promise.resolve([]) : this.retriever.retrieve({ terms, text: retrievalText, limit: this.config.maxChunks * 2 }),
    ]);
    const merged = this.mergeCandidates(scoped, global);

    // 3. Visibility filter (never answer from hidden/rejected services), rank, build context.
    const visibleChunks = merged.filter((c) => {
      // Matching only generic words ("fee", "licence") is not evidence: drop low-coverage chunks.
      if (c.coverage < this.config.minCoverage) return false;
      if (!c.chunk.service_id) return true;
      const s = summaries.get(c.chunk.service_id);
      return !!s && this.visible(s.publication_status);
    });
    const intent = detectSectionIntent(terms);
    const ranked = rankAndDeduplicate(visibleChunks, {
      limit: this.config.maxChunks,
      perServiceCap: req.service_id ? this.config.maxChunks : 5,
      intent,
    });
    const meta = new Map<string, ServiceMeta>();
    for (const s of summaries.values()) {
      meta.set(s.service_id, { name: s.service_name, verification: verificationLevel(s.publication_status), last_verified_at: s.last_verified_at });
    }
    const { evidence, contextText } = buildContext(ranked, meta, this.config.maxContextChars);
    const coverageByChunk = new Map(ranked.map((r) => [r.chunk.chunk_id, r.coverage]));
    const related = this.relatedFrom(evidence, relevant.map((h) => h.summary), summaries);

    // 4. No evidence => do not call the model at all.
    if (evidence.length === 0) {
      return { ...base, answer: MESSAGES.noEvidence![language], verification: "unavailable", sources: [], related_services: related };
    }

    // If the question is about a processing time or fees but no retrieved passage is from that section,
    // tell the model explicitly so it cannot fill the gap with a plausible guess.
    const missing = ["timeline", "fees"].filter((sec) => intent.has(sec as never) && !evidence.some((e) => e.section_type === sec));
    const gapNote = missing.length
      ? `\n\nIMPORTANT: none of the sources above state ${missing.map((m) => (m === "timeline" ? "a processing time" : "fees")).join(" or ")}. Say plainly that it is not published in the retrieved sources; do not estimate or generalise.`
      : "";

    // 5. Generate. Failures degrade to showing the retrieved passages.
    let raw: string;
    try {
      const res = await this.llm.complete({
        messages: buildMessages(language, question, contextText + gapNote, req.conversation),
        maxTokens: this.config.maxOutputTokens,
        temperature: this.config.temperature,
      });
      raw = res.text.trim();
      if (!raw) throw new LlmError("upstream_error", "Empty model response", true);
    } catch (err) {
      if (err instanceof LlmError) {
        // Operational log only: error class, never the question or evidence text (privacy).
        console.warn(JSON.stringify({ level: "warn", event: "llm_degraded", code: err.code, retryable: err.retryable }));
        // Without the model's relevance judgement only confidently matching passages are shown.
        const strong = evidence.filter((e) => (coverageByChunk.get(e.chunk_id) ?? 0) >= this.config.degradedMinCoverage);
        if (strong.length === 0) {
          return { ...base, answer: MESSAGES.noEvidence![language], verification: "unavailable", sources: [], related_services: related };
        }
        return {
          ...base,
          answer: MESSAGES.degraded![language],
          verification: strong.every((e) => e.verification === "verified") ? "confirmed" : "unverified",
          sources: this.toCitations(strong, new Set()),
          degraded: true,
          related_services: related,
        };
      }
      throw err;
    }

    // The model judged the retrieved passages irrelevant (see prompt rule 11): treat as "no evidence".
    if (/^\W*NO_ANSWER\b/i.test(raw)) {
      return { ...base, answer: MESSAGES.noEvidence![language], verification: "unavailable", sources: [], related_services: related };
    }

    // 6. Validate citations; strip invalid ones; add honesty notes.
    const check = validateCitations(raw, new Set(evidence.map((e) => e.ref)));
    const citedSet = new Set(check.citedRefs);
    const citedEvidence = evidence.filter((e) => citedSet.has(e.ref));
    let answer = check.answer;
    if (citedEvidence.length === 0) answer += `\n\n${MESSAGES.noCitations![language]}`;
    const basis = citedEvidence.length > 0 ? citedEvidence : evidence;
    const verification = basis.every((e) => e.verification === "verified") ? "confirmed" : "unverified";
    if (verification === "unverified") answer += `\n\n${MESSAGES.unverifiedNotice![language]}`;

    return {
      ...base,
      answer,
      verification,
      sources: this.toCitations(evidence, citedSet),
      related_services: related,
    };
  }

  /** Optional cross-lingual step: non-English question -> English keywords. Failure is non-fatal. */
  private async rewriteQuery(question: string, language: Language): Promise<string | null> {
    if (!this.config.queryRewrite || language === "en") return null;
    try {
      const res = await this.llm.complete({ messages: buildRewriteMessages(question), maxTokens: 200, temperature: 0 });
      // Defensive clamp: the rewrite is only ever used as search keywords, never shown or trusted.
      return res.text.replace(/[^\p{L}\p{N}\s-]/gu, " ").slice(0, 120).trim() || null;
    } catch {
      return null;
    }
  }

  /** Union of scoped and global candidates keeping the best score per chunk. */
  private mergeCandidates(a: ScoredChunk[], b: ScoredChunk[]): ScoredChunk[] {
    const byIndex = new Map<number, ScoredChunk>();
    for (const c of [...a, ...b]) {
      const cur = byIndex.get(c.chunkIndex);
      if (!cur || c.score > cur.score) byIndex.set(c.chunkIndex, c);
    }
    return [...byIndex.values()];
  }

  private relatedFrom(evidence: EvidenceItem[], hits: { service_id: string; service_name: string }[], summaries: Map<string, { service_name: string }>) {
    const ids = new Map<string, string>();
    for (const h of hits) ids.set(h.service_id, h.service_name);
    for (const e of evidence) if (e.service_id && !ids.has(e.service_id)) ids.set(e.service_id, summaries.get(e.service_id)?.service_name ?? e.service_name ?? e.service_id);
    return [...ids].slice(0, 4).map(([service_id, service_name]) => ({ service_id, service_name }));
  }

  /** Deduplicates evidence by URL+section and flags which passages were actually cited. */
  private toCitations(evidence: EvidenceItem[], cited: ReadonlySet<string>): SourceCitation[] {
    const seen = new Set<string>();
    const out: SourceCitation[] = [];
    for (const e of evidence) {
      const key = `${e.source_url}|${e.page_or_section ?? ""}|${e.section_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ref: e.ref,
        title: e.service_name ? `${e.service_name} — ${e.source_title}` : e.source_title,
        url: e.source_url,
        section: e.page_or_section ?? e.section_type,
        retrieved_at: e.retrieved_at,
        last_verified_at: e.last_verified_at,
        verification: e.verification,
        cited: cited.has(e.ref),
      });
    }
    return out;
  }
}
