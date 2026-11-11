/**
 * Typed client for the Worker REST API. The browser only ever talks to the Worker -
 * no third-party keys exist in the frontend. Every call has a timeout and failures
 * are normalised into `ApiError` (parsed from the server's JSON error envelope).
 */
import type { ChatAnswer, CatalogResult, FactResult, SourceCitation } from "../../../../packages/application/dto";
import type { Service } from "../../../../packages/shared/schemas";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** Performs a request and returns parsed JSON, throwing ApiError for non-2xx / network failures. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), opts.timeoutMs ?? 30_000);
  opts.signal?.addEventListener("abort", () => controller.abort(opts.signal!.reason), { once: true });
  try {
    const res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...opts.headers },
      body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
      signal: controller.signal,
    });
    if (!res.ok) {
      let env: { error?: { code?: string; message?: string; request_id?: string } } = {};
      try { env = await res.json(); } catch { /* non-JSON error body */ }
      throw new ApiError(env.error?.code ?? "http_error", env.error?.message ?? `Request failed (${res.status})`, res.status, env.error?.request_id);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (controller.signal.aborted && controller.signal.reason === "timeout") throw new ApiError("timeout", "The request took too long.", 0);
    if (controller.signal.aborted) throw err; // caller cancelled: let the hook ignore it
    throw new ApiError("network_error", "Could not reach the server.", 0);
  } finally {
    clearTimeout(timer);
  }
}

export interface ServiceDetailResponse {
  service: Service;
  verification: "verified" | "unverified";
  availability: Record<string, "published" | "not_published">;
  knowledge_release: string;
}
export interface ChecklistResponse {
  service_id: string;
  verification: "verified" | "unverified";
  status: "published" | "not_published";
  mandatory: Service["required_documents"];
  conditional: Service["required_documents"];
  optional: Service["required_documents"];
  unspecified: Service["required_documents"];
  sources: SourceCitation[];
}
export interface SearchResponse {
  query: string;
  services: { summary: CatalogResult["items"][number]; score: number }[];
  passages: { chunk_id: string; service_id: string | null; service_name: string | null; text: string; source: SourceCitation }[];
}

export interface ChatTurn { role: "user" | "assistant"; content: string }

export const api = {
  catalog: (params: Record<string, string | number | undefined>, signal?: AbortSignal) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return request<CatalogResult>(`/api/v1/catalog?${qs}`, { signal });
  },
  service: (id: string, signal?: AbortSignal) => request<ServiceDetailResponse>(`/api/v1/services/${encodeURIComponent(id)}`, { signal }),
  checklist: (id: string, signal?: AbortSignal) => request<ChecklistResponse>(`/api/v1/services/${encodeURIComponent(id)}/checklist`, { signal }),
  search: (q: string, signal?: AbortSignal) => request<SearchResponse>(`/api/v1/search?q=${encodeURIComponent(q)}&limit=8`, { signal }),
  chat: (body: { question: string; language: string; service_id?: string; conversation: ChatTurn[] }, signal?: AbortSignal) =>
    request<ChatAnswer>("/api/v1/chat", { method: "POST", body, signal, timeoutMs: 60_000 }),
  feedback: (body: { service_id?: string; type: string; message?: string }) => request<{ received: true }>("/api/v1/feedback", { method: "POST", body }),
  version: () => request<{ release_id: string; published_at: string; service_count: number }>("/api/v1/system/version"),
};

export type { ChatAnswer, CatalogResult, FactResult, SourceCitation };
