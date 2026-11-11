/**
 * Administrator state in R2 (still no database).
 *
 *   admin/review-state.json        approve/reject decisions (single JSON doc)
 *   admin/overrides/<id>.json      reviewer-supplied corrections (applied at next rebuild)
 *   admin/uploads/index.json       metadata of uploaded official PDFs
 *   admin/uploads/<sha256>.pdf     the PDFs themselves (picked up by the ingestion job)
 *
 * Concurrency: review-state is one shared document, so writers use R2 conditional
 * puts (`onlyIf` etag) in a small retry loop - an optimistic lock that prevents two
 * reviewers from silently overwriting each other.
 */
import type { ReviewStateStore } from "../../packages/domain/ports";
import { AppError, ValidationError } from "../../packages/domain/errors";
import { LIMITS, R2_KEYS } from "../../packages/shared/constants";
import {
  ReviewState, ServiceOverride, UploadedDocument, type ReviewDecision,
} from "../../packages/shared/schemas";
import { z } from "zod";

const EMPTY_STATE = (now: string): ReviewState => ({ version: 1, updated_at: now, decisions: {} });
const UploadIndex = z.array(UploadedDocument);

export class R2AdminStore implements ReviewStateStore {
  private cache: { state: ReviewState; at: number } | null = null;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly now: () => Date = () => new Date(),
    /** Short TTL so decisions made on another isolate become visible quickly. */
    private readonly ttlMs = 5_000,
  ) {}

  /** Current review decisions (cached briefly; empty when nothing was reviewed yet). */
  async get(): Promise<ReviewState> {
    if (this.cache && this.now().getTime() - this.cache.at < this.ttlMs) return this.cache.state;
    const { state } = await this.read();
    this.cache = { state, at: this.now().getTime() };
    return state;
  }

  private async read(): Promise<{ state: ReviewState; etag: string | null }> {
    const obj = await this.bucket.get(R2_KEYS.reviewState);
    if (!obj) return { state: EMPTY_STATE(this.now().toISOString()), etag: null };
    const parsed = ReviewState.safeParse(JSON.parse(await obj.text()));
    if (!parsed.success) throw new AppError("internal_error", "Stored review state is corrupt.");
    return { state: parsed.data, etag: obj.etag };
  }

  /**
   * Applies decisions atomically. `decisions[id] = null` clears a decision (back to draft).
   * Retries on etag conflicts so concurrent reviewers never lose updates.
   */
  async applyDecisions(changes: Record<string, ReviewDecision | null>): Promise<ReviewState> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { state, etag } = await this.read();
      const next: ReviewState = { ...state, updated_at: this.now().toISOString(), decisions: { ...state.decisions } };
      for (const [id, decision] of Object.entries(changes)) {
        if (decision === null) delete next.decisions[id];
        else next.decisions[id] = decision;
      }
      const result = await this.bucket.put(R2_KEYS.reviewState, JSON.stringify(next), {
        httpMetadata: { contentType: "application/json" },
        // First write must not clobber a concurrently created file; later writes require the etag we read.
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
      });
      if (result) {
        this.cache = { state: next, at: this.now().getTime() };
        return next;
      }
    }
    throw new AppError("internal_error", "Could not save review decision because of concurrent edits. Please retry.");
  }

  async putOverride(override: ServiceOverride): Promise<void> {
    await this.bucket.put(R2_KEYS.override(override.service_id), JSON.stringify(override), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async getOverride(serviceId: string): Promise<ServiceOverride | null> {
    const obj = await this.bucket.get(R2_KEYS.override(serviceId));
    if (!obj) return null;
    return ServiceOverride.parse(JSON.parse(await obj.text()));
  }

  async listUploads(): Promise<UploadedDocument[]> {
    const obj = await this.bucket.get(R2_KEYS.uploadsIndex);
    if (!obj) return [];
    return UploadIndex.parse(JSON.parse(await obj.text()));
  }

  /**
   * Stores an officially-obtained PDF. Validation: size limit, `%PDF-` magic bytes
   * (never trust the client's content-type), content-addressed key (re-uploading the
   * same file is idempotent).
   */
  async putUpload(
    bytes: ArrayBuffer,
    meta: Pick<UploadedDocument, "filename" | "title" | "department" | "origin" | "service_id" | "uploaded_by">,
  ): Promise<UploadedDocument> {
    if (bytes.byteLength === 0) throw new ValidationError("The uploaded file is empty.");
    if (bytes.byteLength > LIMITS.adminUploadBytes) throw new AppError("payload_too_large", "PDF exceeds the 20 MB upload limit.");
    const head = new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5)));
    if (head !== "%PDF-") throw new ValidationError("Only PDF files are accepted.");

    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.bucket.put(R2_KEYS.upload(sha256), bytes, { httpMetadata: { contentType: "application/pdf" } });

    const doc: UploadedDocument = UploadedDocument.parse({
      upload_id: sha256.slice(0, 16),
      sha256,
      size: bytes.byteLength,
      uploaded_at: this.now().toISOString(),
      ...meta,
    });
    const existing = (await this.listUploads()).filter((u) => u.sha256 !== sha256);
    await this.bucket.put(R2_KEYS.uploadsIndex, JSON.stringify([...existing, doc]), { httpMetadata: { contentType: "application/json" } });
    return doc;
  }

  /**
   * Stores one citizen feedback record (type + short message, no identity). Records are
   * individual immutable objects, so concurrent submissions never conflict.
   */
  async putFeedback(item: { service_id: string | null; type: string; message: string | null }): Promise<string> {
    const id = crypto.randomUUID();
    const createdAt = this.now().toISOString();
    await this.bucket.put(`${R2_KEYS.feedbackPrefix}${createdAt.slice(0, 7)}/${createdAt}-${id}.json`, JSON.stringify({ id, created_at: createdAt, ...item }), {
      httpMetadata: { contentType: "application/json" },
    });
    return id;
  }

  /** Newest feedback first (bounded read: at most `limit` objects are fetched). */
  async listFeedback(limit = 50) {
    const listed = await this.bucket.list({ prefix: R2_KEYS.feedbackPrefix, limit: 1000 });
    const keys = listed.objects.map((o) => o.key).sort().reverse().slice(0, limit);
    const out = await Promise.all(keys.map(async (k) => (await (await this.bucket.get(k))?.json()) as { id: string; created_at: string; service_id: string | null; type: string; message: string | null }));
    return out.filter(Boolean);
  }
}
