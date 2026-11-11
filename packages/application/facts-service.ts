/**
 * Per-facet service lookups (eligibility, documents, steps, fees, timeline,
 * appeal). Each returns a `FactResult` that states explicitly when the official
 * source did not publish the information, instead of inventing it.
 * Shared by the REST API and the MCP tools.
 */
import type { KnowledgeRepository } from "../domain/ports";
import { verificationLevel } from "../domain/visibility";
import type { Service } from "../shared/schemas";
import type { CatalogService } from "./catalog-service";
import type { FactResult } from "./dto";

const NOT_PUBLISHED_NOTICE =
  "The official Sewa Setu source does not publish this information. It has not been guessed; please check the official portal or the concerned department.";
const UNVERIFIED_NOTICE =
  "Extracted from the official portal but not yet reviewed by an administrator. Please confirm on the official portal.";

export type FactSection =
  | "eligibility"
  | "required_documents"
  | "application_steps"
  | "fees"
  | "processing_time"
  | "appeal_procedure";

export class FactsService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly repo: KnowledgeRepository,
  ) {}

  async get(serviceId: string, section: FactSection, opts: { applicantCategory?: string } = {}): Promise<FactResult<unknown>> {
    const service = await this.catalog.get(serviceId);
    const { pointer } = await this.repo.getRelease();
    const { data, published } = this.extract(service, section, opts.applicantCategory);
    const verification = verificationLevel(service.publication_status);
    return {
      service_id: service.service_id,
      service_name: service.service_name,
      section,
      status: published ? "published" : "not_published",
      verification,
      data,
      sources: this.catalog.citations(service),
      last_verified_at: service.last_verified_at,
      knowledge_release: pointer.release_id,
      notice: !published ? NOT_PUBLISHED_NOTICE : verification === "unverified" ? UNVERIFIED_NOTICE : null,
    };
  }

  /** Picks the right slice of a service. `published` is false when the slice is empty/unknown. */
  private extract(s: Service, section: FactSection, applicant?: string): { data: unknown; published: boolean } {
    switch (section) {
      case "eligibility":
        return { data: { eligibility: s.eligibility, rejection_conditions: s.rejection_conditions }, published: s.eligibility.length > 0 };
      case "required_documents": {
        const match = (d: { applies_to: string | null }) => !applicant || !d.applies_to || d.applies_to.toLowerCase() === applicant.toLowerCase();
        const docs = [...s.required_documents, ...s.conditional_documents].filter(match);
        return {
          data: {
            mandatory: docs.filter((d) => d.requirement === "mandatory"),
            conditional: docs.filter((d) => d.requirement === "conditional"),
            optional: docs.filter((d) => d.requirement === "optional"),
            unspecified: docs.filter((d) => d.requirement === "unspecified"),
          },
          published: docs.length > 0,
        };
      }
      case "application_steps":
        return { data: { steps: s.application_steps, application_url: s.application_url, official_page_url: s.official_page_url }, published: s.application_steps.length > 0 };
      case "fees":
        return { data: s.fees, published: s.fees.status === "published" };
      case "processing_time":
        return { data: s.processing_time, published: s.processing_time.status === "published" };
      case "appeal_procedure":
        return { data: { appeal: s.appeal_procedure, grievance: s.grievance_procedure }, published: s.appeal_procedure.length > 0 || s.grievance_procedure.length > 0 };
    }
  }
}
