/**
 * Request/response contracts shared by the REST API and the MCP tools.
 * Both transports validate input with these Zod schemas and return these
 * shapes, guaranteeing identical behaviour (spec: MCP must reuse use cases).
 */
import { z } from "zod";
import { LIMITS, SUPPORTED_LANGUAGES } from "../shared/constants";
import type { ServiceSummary } from "../shared/schemas";
import type { VerificationLevel } from "../domain/visibility";

const idSchema = z.string().trim().min(1).max(200).regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase service id");

export const catalogQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(100).optional(),
  department: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(LIMITS.maxPageSize).default(LIMITS.defaultPageSize),
});
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, "query too short").max(200),
  category: z.string().trim().max(100).optional(),
  department: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxSearchResults).default(10),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const serviceIdSchema = idSchema;

export const chatRequestSchema = z.object({
  question: z.string().trim().min(2, "question too short").max(LIMITS.chatQuestionChars),
  language: z.enum(SUPPORTED_LANGUAGES).optional(),
  service_id: idSchema.optional(),
  /** Untrusted prior turns; limited in count and length, never persisted. */
  conversation: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(LIMITS.chatHistoryMessageChars),
      }),
    )
    .max(LIMITS.chatHistoryMessages)
    .default([]),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** Public source metadata attached to every answer and fact. */
export interface SourceCitation {
  ref?: string;
  source_id?: string;
  title: string;
  url: string;
  section: string | null;
  retrieved_at: string;
  last_verified_at: string | null;
  verification: VerificationLevel;
  /** False when the passage was retrieved but the model did not cite it. */
  cited?: boolean;
}

export interface ChatAnswer {
  answer: string;
  language: (typeof SUPPORTED_LANGUAGES)[number];
  /** confirmed = all cited passages reviewed; unverified = some are not; unavailable = no evidence. */
  verification: "confirmed" | "unverified" | "unavailable";
  sources: SourceCitation[];
  knowledge_release: string | null;
  disclaimer: string;
  /** True when the LLM was unreachable and only retrieved passages are shown. */
  degraded?: boolean;
  related_services: { service_id: string; service_name: string }[];
}

export interface Paged<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface CatalogResult extends Paged<ServiceSummary> {
  facets: {
    categories: { name: string; count: number }[];
    departments: { department_id: string; name: string; count: number }[];
  };
  knowledge_release: string;
}

/** Envelope for a single facet of a service (fees, documents, ...). */
export interface FactResult<T> {
  service_id: string;
  service_name: string;
  section: string;
  /** `not_published` => the official source did not state it; never guessed. */
  status: "published" | "not_published";
  verification: VerificationLevel;
  data: T;
  sources: SourceCitation[];
  last_verified_at: string | null;
  knowledge_release: string;
  notice: string | null;
}
