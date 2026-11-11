/**
 * Business rules deciding which records citizens may see and how reliable they are.
 */
import type { ReviewDecision, Service, ServiceSummary } from "../shared/schemas";

export type VerificationLevel = "verified" | "unverified";

/**
 * Applies an administrator decision to a service/summary.
 *
 * Rule: an approval only counts if it was made against the *current* content
 * hash. If the official source changed since the review, the record silently
 * returns to `draft` so stale approvals can never vouch for new text.
 * A rejection is honoured regardless of hash (a conservative default).
 */
export function applyReviewDecision<T extends Pick<ServiceSummary, "publication_status" | "content_hash" | "last_verified_at">>(
  record: T,
  decision: ReviewDecision | undefined,
): T {
  if (!decision) return record;
  if (decision.decision === "rejected") return { ...record, publication_status: "rejected" };
  if (decision.content_hash !== record.content_hash) return record;
  return { ...record, publication_status: "verified", last_verified_at: decision.reviewed_at };
}

/** Whether a record may be shown on citizen-facing surfaces. */
export function isCitizenVisible(status: Service["publication_status"], allowDraft: boolean): boolean {
  if (status === "verified") return true;
  return status === "draft" && allowDraft;
}

export function verificationLevel(status: Service["publication_status"]): VerificationLevel {
  return status === "verified" ? "verified" : "unverified";
}

/** Describes which sections of a service have published data (drives the "unknown" UI states). */
export function describeAvailability(s: Service) {
  const has = (n: number) => (n > 0 ? "published" : "not_published");
  return {
    eligibility: has(s.eligibility.length),
    required_documents: has(s.required_documents.length + s.conditional_documents.length),
    application_steps: has(s.application_steps.length),
    fees: s.fees.status,
    processing_time: s.processing_time.status,
    appeal_procedure: has(s.appeal_procedure.length),
    grievance_procedure: has(s.grievance_procedure.length),
  } as const;
}
