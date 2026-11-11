# API documentation

Base URL: the Worker origin (e.g. `https://sewasetu-ai.<account>.workers.dev`). All citizen routes are public and read-only
except `POST /api/v1/chat` and `POST /api/v1/feedback`. Admin routes require authentication (see [SECURITY.md](SECURITY.md)).
Code: [`worker/routes/`](worker/routes), shared contracts: [`packages/application/dto.ts`](packages/application/dto.ts).

## Conventions

* JSON in/out. Query params and bodies are validated with Zod; failures return `400 validation_error`.
* **Error envelope** for every non-2xx response:
  ```json
  { "error": { "code": "not_found", "message": "…", "details": { }, "request_id": "uuid" } }
  ```
  | code | HTTP | meaning |
  |---|---|---|
  | `validation_error` | 400 | bad query/body (details.issues lists the first problems) |
  | `unauthorized` / `forbidden` | 401 / 403 | admin authentication / allow-list |
  | `not_found` | 404 | unknown service/source/route (hidden and rejected services also return 404) |
  | `payload_too_large` | 413 | body above 64 KB (4 KB for feedback, 20 MB PDF uploads) |
  | `rate_limited` | 429 | per-client limit; `Retry-After` header set |
  | `knowledge_unavailable` / `not_configured` | 503 | no release published yet, corrupt release, admin auth not configured |
  | `upstream_*` | 502/504/429 | Groq failures that cannot be degraded |
* Every response carries `x-request-id`. Pagination: `page` (≥1) and `page_size` (≤ 50, default 20).
* Citizen visibility: only `verified` services are returned unless the Worker var `SERVE_UNREVIEWED_CONTENT=true`
  (then `draft` records are returned and flagged `verification: "unverified"`). `rejected` records are never returned.

## Citizen endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness + knowledge freshness (`available`, `release_id`, `age_hours`, `stale`). No secrets. |
| GET | `/api/v1/catalog` | List services. Query: `q`, `category`, `department`, `page`, `page_size`. Returns items, total, facets (categories/departments with counts). With `q`, order follows BM25 relevance. |
| GET | `/api/v1/services/:serviceId` | Full service record + `verification` + `availability` per section (`published`/`not_published`). |
| GET | `/api/v1/services/:serviceId/checklist` | Documents grouped `mandatory` / `conditional` / `optional` / `unspecified`, each with verbatim condition and sources. Optional `applicant_category`. |
| GET | `/api/v1/departments` | Departments that have visible services, with counts. |
| GET | `/api/v1/search?q=` | Ranked services + guideline passages (with source citation). `q` 2–200 chars, `limit` ≤ 20. |
| GET | `/api/v1/sources/:sourceId` | Public metadata for a source (URL, title, retrieval date, hash). Never raw R2 objects. |
| GET | `/api/v1/system/version` | Active release id, publish time, counts, whether semantic search is available. |
| POST | `/api/v1/chat` | Grounded RAG answer (below). Rate limit 20/min per client. |
| POST | `/api/v1/feedback` | `{ service_id?, type: incorrect\|outdated\|missing\|other, message? ≤500 }`. Stored without identity; digit runs are stripped. |

### `POST /api/v1/chat`

```json
{ "question": "What documents are required for an income certificate?",
  "language": "en",                 // optional: en | as | hi (auto-detected from script when omitted)
  "service_id": "application-for-income-certificate",   // optional filter
  "conversation": [ { "role": "user", "content": "…" } ] }   // optional, ≤ 6 turns, only user/assistant roles
```
Response:
```json
{ "answer": "… [S1] …", "language": "en",
  "verification": "confirmed | unverified | unavailable",
  "sources": [ { "ref": "S1", "title": "…", "url": "https://…", "section": "Requirements tab",
                 "retrieved_at": "…", "last_verified_at": null, "verification": "unverified", "cited": true } ],
  "knowledge_release": "2026-…", "disclaimer": "…", "degraded": false,
  "related_services": [ { "service_id": "…", "service_name": "…" } ] }
```
* `verification`: `confirmed` = every cited passage comes from an administrator-reviewed service; `unverified` = at least one
  cited passage is machine-extracted and not yet reviewed; `unavailable` = nothing relevant found (the model is **not** called).
* `degraded: true` = the LLM was unreachable/rate-limited/returned nothing; the response lists the retrieved passages instead.
* Conversations are never persisted; the question text is not logged.

## Administrator endpoints (`/api/v1/admin/*`)

All require authentication (Cloudflare Access JWT or `Authorization: Bearer <ADMIN_API_TOKEN>`), are rate limited (120/min) and send `Cache-Control: no-store`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/me` | Identity of the caller. |
| GET | `/services` | All services incl. drafts/rejected. Filters: `status`, `q`, `category`, `department`, `has_warnings`; returns `status_counts`. |
| GET | `/services/:id` | Full record, current review decision, pending correction. |
| PUT | `/services/:id/review` | `{ decision: approve\|reject\|reset, notes? }`. Approval is bound to the record's `content_hash`. |
| POST | `/reviews/bulk` | `{ service_ids[≤200], decision }`. |
| PUT | `/services/:id/metadata` | Evidence-backed correction `{ evidence: { source_url, note }, patch: {...} }`; applied at the next rebuild. Corrections without evidence are rejected. |
| GET/POST | `/uploads` | List / upload an officially obtained PDF (`multipart/form-data`: `file`, `title`, `origin`, `department?`, `service_id?`). `%PDF-` magic bytes are checked; max 20 MB; content-addressed. |
| GET | `/ingestion/logs` | Latest releases with extraction reports (failures, unavailable fields). |
| POST | `/rebuild` | Dispatches the ingestion GitHub workflow (`202`). `503 not_configured` when `GITHUB_REPO`/`GITHUB_DISPATCH_TOKEN` are not set. |
| POST | `/releases/activate` | `{ release_id }` — rollback/roll-forward of `current.json` to a validated release. |
| GET | `/feedback` | Newest citizen feedback. |

## MCP

`/mcp` is documented in [MCP_DOCUMENTATION.md](MCP_DOCUMENTATION.md).
