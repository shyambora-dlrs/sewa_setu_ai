/**
 * Catalogue use cases: list/filter services, fetch one service, departments,
 * checklist and release version. Used by REST routes and MCP tools alike.
 */
import { NotFoundError } from "../domain/errors";
import type { KnowledgeRepository } from "../domain/ports";
import { describeAvailability, verificationLevel } from "../domain/visibility";
import type { PublicationStatus, Service, ServiceSummary, SourceRef } from "../shared/schemas";
import type { CatalogQuery, CatalogResult, SourceCitation } from "./dto";

/** Decides which publication statuses a caller may see (citizen vs administrator). */
export type VisibilityPolicy = (status: PublicationStatus) => boolean;

export class CatalogService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly visible: VisibilityPolicy,
  ) {}

  /** Lists visible services with category/department/text filters and pagination. */
  async list(query: CatalogQuery, matchIds?: Set<string> | null): Promise<CatalogResult> {
    const [{ pointer }, all] = await Promise.all([this.repo.getRelease(), this.repo.listSummaries()]);
    const visible = all.filter((s) => this.visible(s.publication_status));

    // Facet counts are computed before category/department filters so the UI can show alternatives.
    const categories = new Map<string, number>();
    const departments = new Map<string, { name: string; count: number }>();
    for (const s of visible) {
      categories.set(s.category, (categories.get(s.category) ?? 0) + 1);
      if (s.department_id) {
        const d = departments.get(s.department_id) ?? { name: s.department_name ?? s.department_id, count: 0 };
        d.count++;
        departments.set(s.department_id, d);
      }
    }

    let filtered = visible;
    if (query.category) filtered = filtered.filter((s) => s.category === query.category);
    if (query.department) {
      const dep = query.department.toLowerCase();
      filtered = filtered.filter((s) => s.department_id === query.department || s.department_name?.toLowerCase() === dep);
    }
    if (matchIds) filtered = filtered.filter((s) => matchIds.has(s.service_id));
    else if (query.q) {
      // Simple substring filter when no ranked ids are supplied (catalogue browsing).
      const needle = query.q.toLowerCase();
      filtered = filtered.filter((s) => s.service_name.toLowerCase().includes(needle));
    }
    if (!matchIds) filtered = [...filtered].sort((a, b) => a.service_name.localeCompare(b.service_name));

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / query.page_size));
    const start = (query.page - 1) * query.page_size;
    return {
      items: filtered.slice(start, start + query.page_size),
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: totalPages,
      facets: {
        categories: [...categories].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
        departments: [...departments]
          .map(([department_id, d]) => ({ department_id, ...d }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      },
      knowledge_release: pointer.release_id,
    };
  }

  /** Returns one visible service or throws NotFoundError (hidden == not found, no existence leak). */
  async get(serviceId: string): Promise<Service> {
    const service = await this.repo.getService(serviceId);
    if (!service || !this.visible(service.publication_status)) {
      throw new NotFoundError(`Service '${serviceId}' was not found in the published catalogue.`, { service_id: serviceId });
    }
    return service;
  }

  async getWithMeta(serviceId: string) {
    const [service, { pointer }] = await Promise.all([this.get(serviceId), this.repo.getRelease()]);
    return {
      service,
      verification: verificationLevel(service.publication_status),
      availability: describeAvailability(service),
      knowledge_release: pointer.release_id,
    };
  }

  /** Document checklist grouped by requirement level (mandatory/conditional/optional/unspecified). */
  async checklist(serviceId: string, applicantCategory?: string) {
    const { service, verification, knowledge_release } = await this.getWithMeta(serviceId);
    const all = [...service.required_documents, ...service.conditional_documents];
    const matches = (d: { applies_to: string | null }) =>
      !applicantCategory || !d.applies_to || d.applies_to.toLowerCase() === applicantCategory.toLowerCase();
    const filtered = all.filter(matches);
    return {
      service_id: service.service_id,
      service_name: service.service_name,
      verification,
      status: filtered.length > 0 ? ("published" as const) : ("not_published" as const),
      mandatory: filtered.filter((d) => d.requirement === "mandatory"),
      conditional: filtered.filter((d) => d.requirement === "conditional"),
      optional: filtered.filter((d) => d.requirement === "optional"),
      unspecified: filtered.filter((d) => d.requirement === "unspecified"),
      sources: this.citations(service),
      knowledge_release,
    };
  }

  /** Departments that have at least one visible service, with counts. */
  async departments() {
    const summaries = (await this.repo.listSummaries()).filter((s) => this.visible(s.publication_status));
    const map = new Map<string, { department_id: string; name: string; service_count: number }>();
    for (const s of summaries) {
      if (!s.department_id) continue;
      const cur = map.get(s.department_id) ?? { department_id: s.department_id, name: s.department_name ?? s.department_id, service_count: 0 };
      cur.service_count++;
      map.set(s.department_id, cur);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async departmentServices(departmentId: string): Promise<ServiceSummary[]> {
    const summaries = (await this.repo.listSummaries()).filter(
      (s) => this.visible(s.publication_status) && s.department_id === departmentId,
    );
    if (summaries.length === 0) throw new NotFoundError(`Department '${departmentId}' has no published services.`, { department_id: departmentId });
    return summaries;
  }

  async version() {
    const { pointer, manifest } = await this.repo.getRelease();
    return {
      release_id: pointer.release_id,
      published_at: pointer.published_at,
      schema_version: manifest.schema_version,
      generated_at: manifest.generated_at,
      service_count: manifest.service_count,
      verified_service_count: manifest.verified_service_count,
      chunk_count: manifest.chunk_count,
      semantic_search_available: manifest.retrieval.embedding_index !== null,
    };
  }

  async source(sourceId: string): Promise<SourceRef> {
    const source = await this.repo.getSource(sourceId);
    if (!source) throw new NotFoundError(`Source '${sourceId}' was not found.`, { source_id: sourceId });
    return source;
  }

  /** Public citations for a service (never exposes raw R2 keys). */
  citations(service: Service): SourceCitation[] {
    const verification = verificationLevel(service.publication_status);
    return service.sources.map((s) => ({
      source_id: s.source_id,
      title: s.title,
      url: s.source_url,
      section: s.page_or_section,
      retrieved_at: s.retrieved_at,
      last_verified_at: service.last_verified_at,
      verification,
    }));
  }
}
