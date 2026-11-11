/**
 * Canonical Zod schemas for the Sewa Setu knowledge repository.
 *
 * These schemas are the single source of truth for every JSON document that is
 * written by the Python ingestion pipeline and read by the Worker:
 *   - service records        (catalog/services/<id>.json)
 *   - catalogue summaries    (catalog/summaries.json)
 *   - chunks                 (chunks/chunk-shard-NNN.json)
 *   - release manifest       (manifest.json) and the active pointer (current.json)
 *   - admin review state     (admin/review-state.json)
 *
 * `scripts/export-schemas.ts` converts them to JSON Schema files under
 * `knowledge-schemas/` so the Python validator checks releases against exactly
 * the contract the Worker will parse. Keep this file free of transforms/effects
 * so that conversion stays lossless.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0";

/** ISO-8601 timestamp (UTC `Z` or an explicit offset). */
const Timestamp = z.iso.datetime({ offset: true });

/**
 * Lifecycle of a service record.
 *  - draft:    machine-extracted, not reviewed by a human (default for all ingested data)
 *  - verified: an administrator reviewed the record against its official sources
 *  - rejected: reviewer found the extraction unusable; hidden from citizens
 */
export const PublicationStatus = z.enum(["draft", "verified", "rejected"]);
export type PublicationStatus = z.infer<typeof PublicationStatus>;

/** How a document requirement applies. "unspecified" is used when the source gives no label. */
export const RequirementLevel = z.enum(["mandatory", "conditional", "optional", "unspecified"]);
export type RequirementLevel = z.infer<typeof RequirementLevel>;

export const SectionType = z.enum([
  "general",
  "eligibility",
  "required_documents",
  "steps",
  "fees",
  "timeline",
  "appeal",
  "grievance",
]);
export type SectionType = z.infer<typeof SectionType>;

/** Provenance of one fact: where it was fetched from and when. */
export const SourceRef = z.object({
  source_id: z.string().min(1),
  source_url: z.url(),
  title: z.string(),
  publisher_or_department: z.string().nullable(),
  document_type: z.enum(["service_page", "directory_page", "html_page", "pdf", "admin_upload"]),
  retrieved_at: Timestamp,
  published_at: Timestamp.nullable(),
  last_modified_at: Timestamp.nullable(),
  content_hash: z.string().min(8),
  page_or_section: z.string().nullable(),
  extraction_method: z.enum(["html", "pdf_text", "pdf_ocr", "manual"]),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** A sentence/step of guidance together with the chunk that supports it. */
export const Statement = z.object({
  text: z.string().min(1),
  source_chunk_id: z.string().nullable(),
});
export type Statement = z.infer<typeof Statement>;

export const ApplicationStep = z.object({
  step: z.number().int().positive(),
  text: z.string().min(1),
  source_chunk_id: z.string().nullable(),
});
export type ApplicationStep = z.infer<typeof ApplicationStep>;

export const DocumentRequirement = z.object({
  name: z.string().min(1),
  requirement: RequirementLevel,
  /** Applicant category the rule applies to, only when the source states one. */
  applies_to: z.string().nullable(),
  /** Verbatim condition text, e.g. "incase of applying from PFC/CSC". */
  condition: z.string().nullable(),
  /** Exact source line the item was parsed from (audit trail). */
  source_text: z.string(),
  source_chunk_id: z.string().nullable(),
});
export type DocumentRequirement = z.infer<typeof DocumentRequirement>;

export const FeeItem = z.object({
  label: z.string(),
  /** Numeric rupee amount when it could be parsed unambiguously, else null. */
  amount: z.number().nonnegative().nullable(),
  /** e.g. "per page" when the source qualifies the amount. */
  unit: z.string().nullable(),
  condition: z.string().nullable(),
  raw_text: z.string(),
});
export type FeeItem = z.infer<typeof FeeItem>;

export const Fees = z.object({
  /** `not_published` means the official source states nothing about fees. */
  status: z.enum(["published", "not_published"]),
  /** Set only when exactly one unconditional fee exists; otherwise see `items`. */
  amount: z.number().nonnegative().nullable(),
  currency: z.literal("INR"),
  items: z.array(FeeItem),
  conditions: z.array(z.string()),
  source_chunk_ids: z.array(z.string()),
});
export type Fees = z.infer<typeof Fees>;

export const ProcessingTime = z.object({
  status: z.enum(["published", "not_published"]),
  value: z.number().nonnegative().nullable(),
  unit: z.enum(["days", "working_days", "hours", "months"]).nullable(),
  /** Verbatim text from the source (used when the value cannot be parsed). */
  text: z.string().nullable(),
  conditions: z.array(z.string()),
  source_chunk_ids: z.array(z.string()),
});
export type ProcessingTime = z.infer<typeof ProcessingTime>;

export const Department = z.object({
  department_id: z.string().min(1),
  name: z.string().min(1),
});
export type Department = z.infer<typeof Department>;

/** Structured service record (spec section 7). Unknown data stays null/empty. */
export const Service = z.object({
  service_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,200}$/),
  service_name: z.string().min(1),
  service_name_as: z.string().nullable(),
  category: z.string().min(1),
  department: Department.nullable(),
  description: z.string().nullable(),
  eligibility: z.array(Statement),
  required_documents: z.array(DocumentRequirement),
  conditional_documents: z.array(DocumentRequirement),
  application_steps: z.array(ApplicationStep),
  fees: Fees,
  processing_time: ProcessingTime,
  designated_authority: z.string().nullable(),
  delivery_method: z.string().nullable(),
  rejection_conditions: z.array(Statement),
  appeal_procedure: z.array(Statement),
  grievance_procedure: z.array(Statement),
  application_url: z.url().nullable(),
  /** Canonical official page for the service (always present for ingested services). */
  official_page_url: z.url().nullable(),
  sources: z.array(SourceRef).min(1),
  publication_status: PublicationStatus,
  /** Set when a reviewer verified the record. Never set by extraction. */
  last_verified_at: Timestamp.nullable(),
  extracted_at: Timestamp,
  content_hash: z.string().min(8),
  /** Fields the extractor could not find; surfaced in the admin panel. */
  extraction_warnings: z.array(z.string()),
});
export type Service = z.infer<typeof Service>;

/** Lightweight record used for listing/searching without loading full services. */
export const ServiceSummary = z.object({
  service_id: z.string(),
  service_name: z.string(),
  service_name_as: z.string().nullable(),
  category: z.string(),
  department_id: z.string().nullable(),
  department_name: z.string().nullable(),
  publication_status: PublicationStatus,
  content_hash: z.string(),
  last_verified_at: Timestamp.nullable(),
  has_fees: z.boolean(),
  has_documents: z.boolean(),
  has_steps: z.boolean(),
  has_processing_time: z.boolean(),
  warning_count: z.number().int().nonnegative(),
});
export type ServiceSummary = z.infer<typeof ServiceSummary>;

export const Chunk = z.object({
  chunk_id: z.string(),
  service_id: z.string().nullable(),
  department_id: z.string().nullable(),
  section_type: SectionType,
  text: z.string().min(1),
  source_url: z.url(),
  source_title: z.string(),
  page_or_section: z.string().nullable(),
  retrieved_at: Timestamp,
  content_hash: z.string(),
  language: z.enum(["en", "as", "hi"]),
});
export type Chunk = z.infer<typeof Chunk>;

export const CurrentPointer = z.object({
  release_id: z.string().min(1),
  published_at: Timestamp,
  schema_version: z.string(),
  /** Previous release IDs kept for rollback, newest first. */
  previous_release_ids: z.array(z.string()).optional(),
});
export type CurrentPointer = z.infer<typeof CurrentPointer>;

export const ReleaseFile = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});

export const Manifest = z.object({
  release_id: z.string(),
  schema_version: z.string(),
  generated_at: Timestamp,
  source_count: z.number().int().nonnegative(),
  service_count: z.number().int().nonnegative(),
  verified_service_count: z.number().int().nonnegative(),
  chunk_count: z.number().int().nonnegative(),
  chunk_shard_size: z.number().int().positive(),
  retrieval: z.object({
    keyword_index: z.string(),
    embedding_index: z.string().nullable(),
    embedding_model: z.string().nullable(),
  }),
  files: z.array(ReleaseFile),
  validation_status: z.enum(["passed", "failed"]),
});
export type Manifest = z.infer<typeof Manifest>;

/** BM25 index metadata (indexes/bm25-v1/meta.json). Postings live in shard files. */
export const Bm25Meta = z.object({
  version: z.literal(1),
  k1: z.number(),
  b: z.number(),
  doc_count: z.number().int().nonnegative(),
  avg_doc_len: z.number().nonnegative(),
  shard_count: z.number().int().positive(),
  /** chunk ids in index order; doc index i == position in chunk shards. */
  doc_ids: z.array(z.string()),
  doc_lens: z.array(z.number().int().nonnegative()),
});
export type Bm25Meta = z.infer<typeof Bm25Meta>;

/** One shard: term -> list of [docIndex, termFrequency]. */
export const Bm25Shard = z.record(z.string(), z.array(z.tuple([z.number().int(), z.number().int()])));
export type Bm25Shard = z.infer<typeof Bm25Shard>;

/** Embedding index metadata; vectors are int8-quantised per shard (see RAG docs). */
export const EmbeddingMeta = z.object({
  version: z.literal(1),
  model: z.string(),
  dimensions: z.number().int().positive(),
  doc_ids: z.array(z.string()),
  shard_size: z.number().int().positive(),
});
export type EmbeddingMeta = z.infer<typeof EmbeddingMeta>;

/* ------------------------------------------------------------------ */
/* Administrator review state (stored in R2 under admin/)              */
/* ------------------------------------------------------------------ */

export const ReviewDecision = z.object({
  decision: z.enum(["approved", "rejected"]),
  /** Approval is only valid for this exact extracted content (stale if it changes). */
  content_hash: z.string(),
  reviewer: z.string(),
  reviewed_at: Timestamp,
  notes: z.string().max(2000).nullable(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

export const ReviewState = z.object({
  version: z.literal(1),
  updated_at: Timestamp,
  decisions: z.record(z.string(), ReviewDecision),
});
export type ReviewState = z.infer<typeof ReviewState>;

/** Admin-supplied corrections; applied at the next ingestion rebuild. */
export const ServiceOverride = z.object({
  service_id: z.string(),
  updated_by: z.string(),
  updated_at: Timestamp,
  /** Evidence for the correction; overrides without a source are rejected. */
  evidence: z.object({ source_url: z.url(), note: z.string().min(3).max(2000) }),
  patch: z
    .object({
      service_name_as: z.string().nullable(),
      description: z.string().nullable(),
      eligibility: z.array(z.string().min(1)),
      application_steps: z.array(z.string().min(1)),
      designated_authority: z.string().nullable(),
      delivery_method: z.string().nullable(),
      processing_time_text: z.string().nullable(),
      appeal_procedure: z.array(z.string().min(1)),
      grievance_procedure: z.array(z.string().min(1)),
    })
    .partial(),
});
export type ServiceOverride = z.infer<typeof ServiceOverride>;

export const UploadedDocument = z.object({
  upload_id: z.string(),
  sha256: z.string().length(64),
  filename: z.string(),
  title: z.string(),
  department: z.string().nullable(),
  /** Where the administrator obtained the document officially (URL or description). */
  origin: z.string(),
  service_id: z.string().nullable(),
  size: z.number().int().nonnegative(),
  uploaded_by: z.string(),
  uploaded_at: Timestamp,
});
export type UploadedDocument = z.infer<typeof UploadedDocument>;
