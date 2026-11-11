/**
 * Decorator that layers administrator review decisions over a release.
 *
 * Releases are immutable, but approvals must take effect immediately. This
 * repository wraps any KnowledgeRepository and rewrites `publication_status`
 * and `last_verified_at` using the current review state (see
 * `applyReviewDecision` for the stale-approval rule).
 */
import type { KnowledgeRepository, ReleaseInfo, ReviewStateStore } from "../domain/ports";
import { applyReviewDecision } from "../domain/visibility";
import type { Chunk, Department, Service, ServiceSummary, SourceRef } from "../shared/schemas";

export class ReviewOverlayRepository implements KnowledgeRepository {
  constructor(
    private readonly inner: KnowledgeRepository,
    private readonly reviews: ReviewStateStore,
  ) {}

  getRelease(): Promise<ReleaseInfo> {
    return this.inner.getRelease();
  }

  async listSummaries(): Promise<ServiceSummary[]> {
    const [summaries, state] = await Promise.all([this.inner.listSummaries(), this.reviews.get()]);
    return summaries.map((s) => applyReviewDecision(s, state.decisions[s.service_id]));
  }

  async getService(serviceId: string): Promise<Service | null> {
    const [service, state] = await Promise.all([this.inner.getService(serviceId), this.reviews.get()]);
    return service ? applyReviewDecision(service, state.decisions[serviceId]) : null;
  }

  listDepartments(): Promise<Department[]> {
    return this.inner.listDepartments();
  }
  getChunksByIndex(indices: number[]): Promise<(Chunk | null)[]> {
    return this.inner.getChunksByIndex(indices);
  }
  getSource(sourceId: string): Promise<SourceRef | null> {
    return this.inner.getSource(sourceId);
  }
}
