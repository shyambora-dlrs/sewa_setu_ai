/**
 * Admin API client. Authentication is either Cloudflare Access (cookie/JWT added by
 * Access in front of the Worker - nothing to do here) or a bearer token the
 * administrator pastes in; the token is kept in sessionStorage only (cleared when the tab closes).
 */
import type { CatalogResult } from "../../../../packages/application/dto";
import type { ReviewDecision, Service, ServiceOverride, UploadedDocument } from "../../../../packages/shared/schemas";
import { request } from "./api";

const KEY = "sewasetu.admin.token";
export const adminToken = {
  get: () => { try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; } },
  set: (v: string) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
};
const auth = (): Record<string, string> => (adminToken.get() ? { authorization: `Bearer ${adminToken.get()}` } : {});
const B = "/api/v1/admin";

export interface AdminList extends Omit<CatalogResult, "items"> {
  items: CatalogResult["items"];
  status_counts: { draft: number; verified: number; rejected: number };
}
export interface AdminDetail {
  service: Service;
  verification: string;
  availability: Record<string, string>;
  review: ReviewDecision | null;
  pending_override: ServiceOverride | null;
}
export interface ReleaseListing {
  release_id: string; active: boolean; generated_at: string | null; service_count: number | null; chunk_count: number | null;
  validation_status: string | null;
  report: { totals?: Record<string, number>; failures?: { url: string; stage: string; error: string }[]; unavailable_fields?: Record<string, number> } | null;
}

export const adminApi = {
  me: () => request<{ identity: string; method: string }>(`${B}/me`, { headers: auth() }),
  services: (params: Record<string, string | number | undefined>) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return request<AdminList>(`${B}/services?${qs}`, { headers: auth() });
  },
  service: (id: string) => request<AdminDetail>(`${B}/services/${encodeURIComponent(id)}`, { headers: auth() }),
  review: (id: string, decision: "approve" | "reject" | "reset", notes?: string) =>
    request(`${B}/services/${encodeURIComponent(id)}/review`, { method: "PUT", body: { decision, notes }, headers: auth() }),
  bulk: (service_ids: string[], decision: "approve" | "reject" | "reset") => request<{ updated: number; missing: string[] }>(`${B}/reviews/bulk`, { method: "POST", body: { service_ids, decision }, headers: auth() }),
  saveMetadata: (id: string, body: unknown) => request(`${B}/services/${encodeURIComponent(id)}/metadata`, { method: "PUT", body, headers: auth() }),
  uploads: () => request<{ uploads: UploadedDocument[] }>(`${B}/uploads`, { headers: auth() }),
  upload: (form: FormData) => request<{ upload: UploadedDocument }>(`${B}/uploads`, { method: "POST", form, headers: auth(), timeoutMs: 120_000 }),
  logs: () => request<{ releases: ReleaseListing[] }>(`${B}/ingestion/logs`, { headers: auth() }),
  rebuild: () => request<{ dispatched: boolean }>(`${B}/rebuild`, { method: "POST", headers: auth() }),
  activate: (release_id: string) => request(`${B}/releases/activate`, { method: "POST", body: { release_id }, headers: auth() }),
  feedback: () => request<{ items: { id: string; created_at: string; service_id: string | null; type: string; message: string | null }[] }>(`${B}/feedback`, { headers: auth() }),
};
