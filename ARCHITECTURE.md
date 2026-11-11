# Architecture

Sewa Setu AI is an **independent** citizen-guidance assistant for Assam government services (source: <https://sewasetu.assam.gov.in/>).
It is deliberately **database-free**: the persistent store is a private **Cloudflare R2** bucket of versioned JSON files.

```
                     PUBLIC INTERNET
                           │
                  ┌────────▼─────────┐
                  │ Cloudflare Worker│  worker/index.ts (Hono)
                  └─┬──────┬───────┬─┘
        static assets│      │/api/v1│ /mcp (Streamable HTTP, stateless)
         React SPA   │      │       │
                     │   controllers (worker/routes) ── MCP tools (worker/mcp)
                     │              │ both call
                     │      application use cases  (packages/application)
                     │      CatalogService · FactsService · SearchService · RagService
                     │              │ depend on ports (packages/domain/ports.ts)
        ┌────────────┴───────┬──────┴───────┬────────────────┐
   KnowledgeRepository   IndexStore    LlmProvider     EmbeddingProvider(opt.)
   R2KnowledgeRepository  (same class)  GroqClient       WorkersAiEmbeddings
        │                                    │                  │
   R2 bucket (private)                  Groq API         Workers AI bge-m3
   releases/<id>/…  current.json
   admin/ (reviews, overrides, uploads)   feedback/

 CONTENT PUBLISHING – never inside a Worker request
 GitHub Actions (daily + manual + admin "Rebuild")
   Python: crawl → extract HTML/PDF(+OCR) → normalise → validate → chunk → BM25 (+embeddings)
   → upload immutable release → verify → write current.json LAST
```

## Layers (SOLID)
| Layer | Location | Responsibility |
|---|---|---|
| Shared contracts | `packages/shared` | Zod schemas (single source of truth → exported to JSON Schema for Python), constants, tokenizer |
| Domain | `packages/domain` | errors, **ports** (interfaces), language detection, visibility/verification rules |
| Retrieval | `packages/retrieval` | BM25 searcher/builder, hybrid retriever, ranking, context builder, lexicon, vector helpers |
| Application | `packages/application` | use cases + DTOs + prompt/guards; `container.ts` wires them from ports |
| Infrastructure adapters | `worker/adapters` | R2 repository/admin store/release admin, Groq, Workers AI, GitHub dispatcher |
| Interface | `worker/routes`, `worker/mcp`, `worker/middleware` | HTTP controllers, MCP tools, auth, rate limiting |
| Composition root | `worker/services.ts` | the only place that names concrete adapters |
| Frontend | `apps/web` | React SPA (citizen + admin) |
| Ingestion | `ingestion/sewasetu_ingest` | crawler, extractors, normalisers, validators, chunker, indexers, embeddings, publisher |

Swapping Groq or the embedding provider means writing another adapter for `LlmProvider` / `EmbeddingProvider`; no use case changes.
Tests build the same container from in-memory fakes (`tests/helpers/fakes.ts`).

## Data model and R2 layout
```
sewasetu-knowledge/
├── current.json                      ← the ONLY mutable release object: { release_id, published_at, schema_version, previous_release_ids }
├── releases/<release_id>/            ← immutable; never overwritten
│   ├── manifest.json                 counts, file list with sha256, retrieval config, validation status
│   ├── catalog/{summaries.json, departments.json, sources.json, services/<service_id>.json}
│   ├── chunks/chunk-shard-NNN.json   200 chunks per shard
│   ├── indexes/bm25-v1/{meta.json, shard-00..15.json}      (+ indexes/embeddings-v1/ when enabled)
│   └── reports/{extraction-report.json, validation-report.json}
├── sources/{html,pdf}/<sha256>…      content-addressed raw snapshots (history of official text)
├── sources/source-registry.json      URL → hash/ETag/Last-Modified/history (change detection)
├── admin/{review-state.json, overrides/<id>.json, uploads/…}      administrator state
└── feedback/<yyyy-mm>/…              citizen feedback records
```
Deviation from the spec sketch: the catalogue is split into `summaries.json` + one file per service (instead of a single
`services.json`) so a request never parses the full corpus on the Workers CPU budget.

### Service record states
`draft` (machine-extracted — the only state ingestion produces) → `verified` (administrator approval bound to the record's content hash) or `rejected`.
Unknown facts stay `null`/`[]`/`not_published`. Every fee/processing time/mandatory document links to its supporting chunk.
Verification flows to the UI, the REST API, MCP results and RAG answers (confirmed / unverified / unavailable).

### Caching and freshness
`current.json` is cached for 30 s per isolate; everything under `releases/<id>/` is cached keyed by release id, so a new release can never serve stale index data and becomes visible within 30 s. Review decisions are cached 5 s.

## Why the Worker stays light
Crawling, PDF text extraction, OCR, chunking, index building and embedding generation all run in Python on GitHub Actions. The Worker only reads a few small JSON files per request (service files, a handful of index shards, ≤ 24 candidate chunks) and makes one (optionally two) Groq calls.

## Key decisions
* **No database / D1 / KV / Durable Objects / Vectorize** (spec). Mutable admin state is a handful of JSON objects in R2 with optimistic locking (conditional puts on etag) for the shared review document.
* **Admin without a database:** review decisions live in R2 and are overlaid at read time (`ReviewOverlayRepository`) so approvals take effect immediately, and are also baked into the next release by the ingestion job so releases are self-contained.
* **Release immutability and atomic publish:** upload → verify checksums → write `current.json` last; previous releases kept for rollback.
* **Approval bound to content hash:** if the official page changes, the approval silently stops applying.
* **BM25 first:** semantic retrieval is optional and bounded; no vector database.
