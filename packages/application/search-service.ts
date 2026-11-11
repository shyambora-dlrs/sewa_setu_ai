/**
 * Search use cases.
 *  - searchServices: ranks catalogue entries by name/department/category (BM25 in memory).
 *  - searchPassages: retrieves official guideline passages (BM25 [+ semantic]).
 */
import { Bm25Searcher, buildInMemoryBm25, type Bm25Source } from "../retrieval/bm25";
import { detectSectionIntent, rankAndDeduplicate } from "../retrieval/chunk-ranker";
import { expandQueryTerms } from "../retrieval/lexicon";
import type { ChunkRetriever } from "../retrieval/types";
import type { KnowledgeRepository } from "../domain/ports";
import { verificationLevel } from "../domain/visibility";
import type { ServiceSummary } from "../shared/schemas";
import type { SourceCitation } from "./dto";
import type { VisibilityPolicy } from "./catalog-service";

export interface ServiceSearchHit {
  summary: ServiceSummary;
  score: number;
}

export interface PassageHit {
  chunk_id: string;
  service_id: string | null;
  service_name: string | null;
  section_type: string;
  text: string;
  score: number;
  source: SourceCitation;
}

export class SearchService {
  /** Catalogue index cache keyed by release id so a new release is never served stale. */
  private catalogCache: { releaseId: string; source: Bm25Source; summaries: ServiceSummary[] } | null = null;

  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly retriever: ChunkRetriever,
    private readonly visible: VisibilityPolicy,
  ) {}

  /** Builds (or reuses) the in-memory catalogue index for the active release. */
  private async catalogIndex() {
    const { pointer } = await this.repo.getRelease();
    if (this.catalogCache?.releaseId === pointer.release_id) return this.catalogCache;
    const summaries = await this.repo.listSummaries();
    const source = buildInMemoryBm25(
      summaries.map((s) => ({
        id: s.service_id,
        // The service name is repeated so that name matches outweigh department/category matches.
        text: [s.service_name, s.service_name, s.service_name, s.service_name_as ?? "", s.department_name ?? "", s.category].join(" "),
      })),
    );
    this.catalogCache = { releaseId: pointer.release_id, source, summaries };
    return this.catalogCache;
  }

  /**
   * Finds services for a free-text query. Visibility is re-applied on the *current*
   * summaries (review decisions may have changed since the index was built).
   */
  async searchServices(
    query: string,
    opts: { limit: number; category?: string; department?: string; extraTerms?: string[] },
  ): Promise<ServiceSearchHit[]> {
    const { source } = await this.catalogIndex();
    const current = new Map((await this.repo.listSummaries()).map((s) => [s.service_id, s]));
    const terms = [...expandQueryTerms(query), ...(opts.extraTerms ?? [])];
    const hits = await new Bm25Searcher(source).search(terms, { limit: Math.max(opts.limit * 4, 40) });
    const dep = opts.department?.toLowerCase();
    const out: ServiceSearchHit[] = [];
    for (const h of hits) {
      const s = current.get(h.docId);
      if (!s || !this.visible(s.publication_status)) continue;
      if (opts.category && s.category !== opts.category) continue;
      if (dep && s.department_id?.toLowerCase() !== dep && s.department_name?.toLowerCase() !== dep) continue;
      out.push({ summary: s, score: h.score });
      if (out.length >= opts.limit) break;
    }
    return out;
  }

  /** Retrieves ranked official passages with full source attribution. */
  async searchPassages(
    query: string,
    opts: { limit: number; department?: string; serviceIds?: string[] },
  ): Promise<PassageHit[]> {
    const terms = expandQueryTerms(query);
    const raw = await this.retriever.retrieve({ terms, text: query, serviceIds: opts.serviceIds, limit: opts.limit * 3 });
    const summaries = new Map((await this.repo.listSummaries()).map((s) => [s.service_id, s]));
    const dep = opts.department?.toLowerCase();

    const allowed = raw.filter((r) => {
      const s = r.chunk.service_id ? summaries.get(r.chunk.service_id) : undefined;
      if (r.chunk.service_id && (!s || !this.visible(s.publication_status))) return false;
      if (dep && s && s.department_id?.toLowerCase() !== dep && s.department_name?.toLowerCase() !== dep) return false;
      return true;
    });
    const ranked = rankAndDeduplicate(allowed, { limit: opts.limit, perServiceCap: opts.limit, intent: detectSectionIntent(terms) });
    return ranked.map((r) => {
      const s = r.chunk.service_id ? summaries.get(r.chunk.service_id) : undefined;
      const verification = s ? verificationLevel(s.publication_status) : "unverified";
      return {
        chunk_id: r.chunk.chunk_id,
        service_id: r.chunk.service_id,
        service_name: s?.service_name ?? null,
        section_type: r.chunk.section_type,
        text: r.chunk.text,
        score: Number(r.score.toFixed(5)),
        source: {
          title: r.chunk.source_title,
          url: r.chunk.source_url,
          section: r.chunk.page_or_section,
          retrieved_at: r.chunk.retrieved_at,
          last_verified_at: s?.last_verified_at ?? null,
          verification,
        },
      };
    });
  }
}
