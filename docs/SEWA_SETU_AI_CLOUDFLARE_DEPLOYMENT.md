# Sewa Setu AI — Cloudflare Deployment and Implementation Specification

**Document type:** Architecture, deployment and Claude implementation brief  
**Project:** Sewa Setu AI — Citizen Service Discovery and Guidance Assistant  
**Target hosting:** Cloudflare Workers + Workers Static Assets + R2  
**LLM:** Groq API  
**Optional embeddings:** Cloudflare Workers AI (`@cf/baai/bge-m3`)  
**Knowledge storage:** Versioned JSON, Markdown, extracted text and index files in R2  
**Database requirement:** No PostgreSQL, MySQL, MongoDB, D1, KV, Durable Objects or Vectorize in the initial implementation  
**Document date:** 11 November 2026

---

## 1. Purpose

Implement and deploy a production-minded Sewa Setu citizen guidance application on Cloudflare. The application will help users discover Assam government services and understand official eligibility conditions, document requirements, application steps, fees, processing timelines, responsible departments, appeal routes and grievance channels.

The product is an independent information assistant. It must not claim to be an official Assam Government application, issue certificates, submit applications, guarantee eligibility or make decisions on behalf of a government department.

Primary source: <https://sewasetu.assam.gov.in/>

Additional departmental sources may be added only after they have been identified and reviewed. Every extracted fact must retain its official source URL and verification metadata.

## 2. Core architecture decision

Use one Cloudflare Worker application to serve:

- React + TypeScript citizen frontend as static assets.
- HTTP API routes for catalogue search, service details and AI chat.
- A remote MCP endpoint using Streamable HTTP.
- R2 access for the knowledge repository and versioned search indexes.
- An optional Workers AI binding for query embeddings.

Use GitHub Actions as the background ingestion runner. Do not perform large-scale crawling, PDF extraction, OCR, chunking or bulk embedding generation inside a normal Worker request. The GitHub-hosted runner performs those jobs and publishes a complete, versioned knowledge release to R2.

### 2.1 Why this arrangement

Cloudflare Workers are suitable for low-latency APIs and MCP request handling. Static assets can be deployed with the Worker. R2 provides persistent object storage without requiring a relational database. GitHub Actions can run Python document-processing dependencies outside the constrained request runtime.

The Worker must remain stateless. It reads the active content release from R2 and does not keep user conversations or mutable application state in process memory between requests.

### 2.2 No-database rule

The initial release MUST NOT introduce:

- PostgreSQL or Postgres-compatible hosted services.
- MySQL or MariaDB.
- MongoDB.
- Cloudflare D1.
- Cloudflare KV as a database substitute.
- Cloudflare Durable Objects for chat/session persistence.
- Cloudflare Vectorize.

Use R2 objects as the persistent knowledge repository. Use in-memory objects only as request-scoped computation or short-lived runtime caching. Do not represent R2 as a relational database.

If a later release genuinely requires transactional user accounts, application tracking or large-scale vector search, document that as a separate architecture decision and obtain approval before adding a database product.

## 3. Deployment topology

```text
                         PUBLIC INTERNET
                                |
                  https://ai.example.in (optional)
                                |
                       CLOUDFLARE WORKER
                                |
          +---------------------+----------------------+
          |                     |                      |
       React SPA              HTTP API              MCP endpoint
     static assets          /api/v1/*                 /mcp
          |                     |                      |
          +---------------------+----------------------+
                                |
                      DOMAIN / APPLICATION LAYER
                                |
                 +--------------+---------------+
                 |                              |
          R2 knowledge bucket             Groq API
       catalog, sources, chunks,       answer generation
          indexes, manifests                  |
                 |                            |
                 +---------------+------------+
                                 |
                       Optional Workers AI
                       multilingual embeddings
                                 ^
                                 |
                        query-time embedding

   CONTENT PUBLISHING (not a Worker request)

   GitHub Actions scheduled/manual workflow
                    |
           Sewa Setu + official sources
                    |
        HTML / PDF download and extraction
                    |
       normalize -> validate -> chunk -> index
                    |
        optional embedding generation
                    |
           upload a new release to R2
                    |
        update current.json pointer last
```

### 3.1 Suggested public hostnames

Use a single Worker with path-based routing initially:

| Purpose | URL example |
|---|---|
| Citizen application | `https://ai.example.in/` |
| API | `https://ai.example.in/api/v1/` |
| MCP | `https://ai.example.in/mcp` |
| Health check | `https://ai.example.in/health` |
| Admin/review interface (future) | `https://ai.example.in/admin/` |

A custom domain is optional. First deploy to the Worker `workers.dev` hostname and test it. Add a custom domain only after DNS is managed through Cloudflare and the deployment is verified.

## 4. Technology stack

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | React + TypeScript + Vite | Citizen chat and service discovery UI |
| UI styling | Tailwind CSS + accessible component system | Responsive, accessible interface |
| Cloudflare integration | `@cloudflare/vite-plugin` + Wrangler | Local Worker runtime and deployment |
| Worker routing | Hono or small Web Standards router | API and MCP route composition |
| MCP | Cloudflare Agents SDK `createMcpHandler` + MCP SDK v2 | Stateless remote MCP server |
| Validation | Zod | Validate API, ingestion and MCP inputs |
| Persistent content | Cloudflare R2 | Versioned JSON, Markdown and source files |
| LLM | Groq chat completions API | Grounded answer generation |
| Keyword retrieval | BM25 / inverted index | Fast service and passage retrieval |
| Optional embedding | Workers AI `@cf/baai/bge-m3` | Multilingual semantic query vectors |
| Ingestion | Python 3.12+ | Crawling, parsing, extraction and index building |
| HTML extraction | Requests + BeautifulSoup | Source page extraction |
| PDF extraction | PyMuPDF | Text extraction from PDFs |
| OCR fallback | Tesseract | Scanned PDFs only when needed |
| Automation | GitHub Actions | Daily/manual ingestion and publishing |
| Tests | Vitest + Python pytest | Unit, integration and regression testing |

Use the Cloudflare Vite plugin and current supported Wrangler tooling. Check current package compatibility before pinning versions. Do not copy outdated package versions from old tutorials.

## 5. Repository structure

Use a TypeScript monorepo with a separate Python ingestion package.

```text
sewasetu-ai/
├── apps/
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── components/
│       │   │   ├── chat/
│       │   │   ├── service/
│       │   │   ├── checklist/
│       │   │   └── layout/
│       │   ├── pages/
│       │   ├── hooks/
│       │   ├── services/
│       │   ├── i18n/
│       │   └── main.tsx
│       └── index.html
├── worker/
│   ├── index.ts
│   ├── routes/
│   │   ├── health.routes.ts
│   │   ├── services.routes.ts
│   │   ├── chat.routes.ts
│   │   └── admin.routes.ts
│   ├── mcp/
│   │   ├── create-server.ts
│   │   └── tools/
│   ├── middleware/
│   └── adapters/
│       ├── r2-knowledge-repository.ts
│       └── groq-client.ts
├── packages/
│   ├── domain/
│   │   ├── entities/
│   │   ├── value-objects/
│   │   └── ports/
│   ├── application/
│   │   ├── use-cases/
│   │   └── dto/
│   ├── retrieval/
│   │   ├── bm25-retriever.ts
│   │   ├── hybrid-retriever.ts
│   │   ├── chunk-ranker.ts
│   │   └── context-builder.ts
│   └── shared/
│       ├── schemas/
│       ├── constants/
│       └── types/
├── ingestion/
│   ├── requirements.txt
│   ├── config/
│   │   ├── sources.yaml
│   │   └── crawl-policy.yaml
│   ├── crawler/
│   ├── extractors/
│   ├── normalizers/
│   ├── validators/
│   ├── chunkers/
│   ├── indexers/
│   ├── embeddings/
│   ├── publisher/
│   ├── tests/
│   └── run_ingestion.py
├── knowledge-schemas/
│   ├── service.schema.json
│   ├── chunk.schema.json
│   └── manifest.schema.json
├── scripts/
│   ├── validate-release.ts
│   └── local-smoke-test.ts
├── .github/
│   └── workflows/
│       ├── deploy-worker.yml
│       └── ingest-and-publish.yml
├── docs/
├── tests/
├── .dev.vars.example
├── .gitignore
├── package.json
├── tsconfig.json
├── vite.config.ts
└── wrangler.jsonc
```

Claude may refine the folder names, but must preserve the separation between domain logic, application use cases, infrastructure adapters, frontend, MCP and Python ingestion.

## 6. Cloudflare resources

Create these resources in the Cloudflare account:

1. One R2 bucket: `sewasetu-knowledge`.
2. One Worker: `sewasetu-ai`.
3. One Workers AI binding (optional initially; enable when semantic retrieval is implemented).
4. One custom domain (optional).

Do not create D1, KV, Durable Objects, Queues or Vectorize for the first release.

### 6.1 R2 object layout

Keep source documents separate from generated releases. Publish each generated release under a unique ID.

```text
sewasetu-knowledge/
├── sources/
│   ├── html/
│   ├── pdf/
│   └── source-registry.json
├── releases/
│   └── 2026-11-11T220000Z-a1b2c3/
│       ├── manifest.json
│       ├── catalog/
│       │   ├── services.json
│       │   └── departments.json
│       ├── chunks/
│       │   ├── chunk-shard-000.json
│       │   └── chunk-shard-001.json
│       ├── indexes/
│       │   ├── bm25-v1.json
│       │   └── embeddings-v1.json       # optional
│       └── reports/
│           ├── extraction-report.json
│           └── validation-report.json
└── current.json
```

`current.json` points to the active release ID. The Worker reads this pointer first and uses the referenced release path for all subsequent knowledge reads.

**Atomic publishing rule:** Upload all new documents, chunks, catalogue files, indexes and reports first. Validate their presence and checksums. Update `current.json` only as the final publishing operation. This prevents users from reading a partially uploaded release.

Use immutable release paths. Never overwrite an active release in place. Keep at least the previous two known-good releases to support rollback. Define a retention policy for old raw files and releases.

### 6.2 Example `current.json`

```json
{
  "release_id": "2026-11-11T220000Z-a1b2c3",
  "published_at": "2026-11-11T22:00:00Z",
  "schema_version": "1.0.0"
}
```

### 6.3 Example release manifest

```json
{
  "release_id": "2026-11-11T220000Z-a1b2c3",
  "schema_version": "1.0.0",
  "generated_at": "2026-11-11T22:00:00Z",
  "source_count": 0,
  "service_count": 0,
  "chunk_count": 0,
  "retrieval": {
    "keyword_index": "indexes/bm25-v1.json",
    "embedding_index": null,
    "embedding_model": null
  },
  "files": [],
  "validation_status": "passed"
}
```

All counts above are placeholders. The ingestion pipeline must generate actual values. Do not insert invented service counts.

## 7. Service knowledge schema

Each service must be a structured JSON object. Unknown fields must be `null`, an empty array or an explicit `not_published` value. Never ask an LLM to invent missing fees, documents, eligibility rules or timelines.

```json
{
  "service_id": "income-certificate",
  "service_name": "Income Certificate",
  "service_name_as": null,
  "category": "certificates",
  "department": {
    "department_id": "department-id",
    "name": "Official department name"
  },
  "description": null,
  "eligibility": [],
  "required_documents": [],
  "conditional_documents": [],
  "application_steps": [],
  "fees": {
    "amount": null,
    "currency": "INR",
    "conditions": [],
    "source_chunk_ids": []
  },
  "processing_time": {
    "value": null,
    "unit": null,
    "conditions": [],
    "source_chunk_ids": []
  },
  "designated_authority": null,
  "delivery_method": null,
  "rejection_conditions": [],
  "appeal_procedure": [],
  "grievance_procedure": [],
  "application_url": null,
  "sources": [],
  "publication_status": "draft",
  "last_verified_at": null,
  "content_hash": null
}
```

Each source item must include `source_url`, `title`, `publisher_or_department`, `document_type`, `retrieved_at`, `published_at` when available, `last_modified_at` when available, `content_hash`, and `page_or_section` when the source is a PDF or multi-section page.

Each document requirement should also track whether it is mandatory, conditional or optional, the applicant category to which it applies, and the exact source chunk supporting it.

## 8. Ingestion and publishing pipeline

Run ingestion in GitHub Actions, not in the Worker request handler.

### 8.1 Source registry

Create `ingestion/config/sources.yaml` containing approved official URLs and source metadata. Seed it with the Sewa Setu homepage and service directory discovery route. Add departmental source URLs only after verifying that they are official and relevant.

The crawler must:

- Respect the source site's terms, robots policy and reasonable request frequency.
- Use a descriptive User-Agent with a project contact address placeholder.
- Follow only allowed same-site or explicitly allow-listed official links.
- Avoid login-protected pages, CAPTCHA bypass, anti-bot evasion and personal application records.
- Use timeouts, retry limits, exponential backoff and per-host request throttling.
- Track redirects and canonical URLs.
- Prefer conditional requests using ETag or Last-Modified where available.
- Record failures and continue with other sources rather than silently dropping them.

### 8.2 Extraction

For HTML: extract title, service headings, service text, document lists, tables, links and relevant metadata. Remove navigation, footer, scripts and unrelated layout text while retaining meaningful instructions.

For PDFs: use PyMuPDF first. Detect pages with little/no extracted text and route only those pages to OCR. Preserve page numbers, headings, table order and source URL. OCR output must be marked as OCR-derived and sent to review when confidence is poor.

Do not use OCR for ordinary text PDFs. Do not discard table labels or units. Do not convert a conditional requirement into a mandatory requirement.

### 8.3 Normalize and validate

Normalize each service to the schema in Section 7. Deduplicate service pages using canonical URL and content hash. Retain previous versions when meaningful official text changes.

Set `publication_status` to `draft` when the source is ambiguous, incomplete, conflicting or OCR-derived with poor confidence. Only verified records may be included in the citizen-facing active catalogue.

Validation rules:

- Every published service has at least one official source URL.
- Every non-null fee has a supporting source chunk.
- Every non-null processing time has a supporting source chunk.
- Every mandatory document requirement has supporting source text.
- URLs are valid and use HTTPS where the official source supports it.
- Duplicate service IDs are rejected.
- No unsupported facts are accepted from LLM-generated extraction.
- Missing fields remain unknown; they must not be filled by model guessing.

### 8.4 Chunking and indexes

Create chunks by service section and document heading, not arbitrary page length alone. Each chunk must carry:

- `chunk_id`
- `service_id` (when applicable)
- `department_id` (when applicable)
- `section_type` (eligibility, required_documents, steps, fees, timeline, appeal, general)
- `text`
- `source_url`
- `source_title`
- `page_or_section`
- `retrieved_at`
- `content_hash`
- `language`

Keep chunks small enough for focused retrieval. Avoid splitting a numbered instruction or a document requirement across multiple chunks. Include a limited overlap only when necessary for context.

Build a BM25 inverted index for fast keyword retrieval. Shard indexes by category or stable hash so the Worker does not need to load the entire corpus for every request. Add a small catalogue index for service-name lookup.

### 8.5 Embeddings — optional second retrieval stage

For semantic retrieval, use the Workers AI model `@cf/baai/bge-m3` after checking current model availability, output format and usage limits. It is a multilingual embedding model; test retrieval quality specifically on Assamese, English and Hindi service queries before enabling it in production.

Do not use Groq as the embedding provider unless Groq officially lists a supported embedding model and endpoint for the account and model chosen. Groq's role in this specification is answer generation.

Generate document vectors during ingestion, store them in versioned R2 index shards, and compute a query vector at runtime through the Worker's AI binding. Do not generate all document embeddings on every user query. Do not perform a full unbounded vector scan on the Workers Free plan. Start with BM25; enable semantic retrieval only after corpus-size and CPU/load tests. If static vector scans are too expensive, keep BM25 as the default and propose a separate vector database decision rather than silently adding one.

### 8.6 Release publishing

The publishing command must:

1. Create a unique release ID.
2. Write catalogues, source metadata, chunks, BM25 indexes and optional vectors to a temporary local release directory.
3. Validate JSON schemas, content hashes, required metadata and references.
4. Produce extraction and validation reports.
5. Upload all release files to `releases/<release_id>/` in R2.
6. Verify uploaded objects and checksums.
7. Update `current.json` last.
8. Retain the previous active release for rollback.
9. Fail the workflow without switching `current.json` if any validation or upload step fails.

## 9. RAG request flow

For every citizen question:

1. Validate and normalize the request.
2. Detect likely language (Assamese, English or Hindi); retain the original question.
3. Load the active release manifest and catalogue/index shard from R2.
4. Retrieve candidate service records and chunks using BM25.
5. Optionally add semantic retrieval candidates when embedding search is enabled.
6. Apply service/category/department filters if the user specified them.
7. Rank and deduplicate passages.
8. Build a limited evidence context with source URLs and section references.
9. Call Groq chat completions with a strict grounded-answer system prompt.
10. Validate the generated answer and citations against the retrieved evidence.
11. Return answer, source references, verification dates and a clear uncertainty message where evidence is missing.

### 9.1 Required grounding prompt

The system prompt must communicate the following rules:

- Answer only from supplied official retrieved content and trusted source metadata.
- Never invent eligibility, fees, document requirements, processing time, officer names, application status or appeal periods.
- Clearly distinguish mandatory from conditional and optional documents.
- If official sources conflict, disclose the conflict and show both references with dates.
- If no official evidence is retrieved, state that the information could not be verified and direct the user to the relevant official service page or department.
- Cite sources adjacent to the statements they support.
- Do not claim that the user's application has been submitted or approved.
- Do not request Aadhaar number, OTP, bank details or other sensitive credentials in chat.
- For personal application status, direct users to the official portal unless a documented, authorized status API is later integrated.
- Respond in the language requested by the user. Do not translate a legal or administrative term in a way that changes its meaning.

### 9.2 Groq integration

Use the official Groq chat completions endpoint:

`https://api.groq.com/openai/v1/chat/completions`

Store `GROQ_API_KEY` as a Cloudflare Worker secret. Store the selected model ID as a non-secret environment variable such as `GROQ_MODEL`; verify the current model availability in the Groq console before production deployment.

Never expose the Groq API key in React environment variables or browser requests. The browser must call the Worker API only.

Use request timeouts, bounded output tokens, safe retry behavior for transient errors and graceful responses for rate limits. Do not retry non-idempotent requests indefinitely.

## 10. API specification

Use versioned endpoints under `/api/v1`.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Worker health |
| GET | `/api/v1/catalog` | List service catalogue with filters and pagination |
| GET | `/api/v1/services/:serviceId` | Complete published service details |
| GET | `/api/v1/services/:serviceId/checklist` | Structured document checklist |
| GET | `/api/v1/departments` | Department catalogue |
| GET | `/api/v1/search?q=` | Keyword service/passage search |
| POST | `/api/v1/chat` | Grounded RAG response |
| GET | `/api/v1/sources/:sourceId` | Public source metadata, not private raw object access |
| GET | `/api/v1/system/version` | Active knowledge release and schema version |

All endpoints must validate query parameters and request bodies with Zod. Return consistent JSON error envelopes. Apply response-size limits and pagination. Do not expose arbitrary R2 object keys to the client.

Example chat request:

```json
{
  "question": "What documents are required for an income certificate?",
  "language": "en",
  "service_id": "income-certificate",
  "conversation": []
}
```

The `conversation` field must be size-limited and treated as untrusted user input. Do not persist conversations in R2 by default.

Example chat response:

```json
{
  "answer": "Answer grounded in retrieved official text.",
  "language": "en",
  "sources": [
    {
      "title": "Official service guideline",
      "url": "https://official.example.gov.in/service",
      "section": "Documents required",
      "retrieved_at": "2026-11-11T00:00:00Z",
      "last_verified_at": null
    }
  ],
  "knowledge_release": "release-id",
  "disclaimer": "Please verify current requirements on the official portal before applying."
}
```

The example values are schema illustrations only and must not be presented as real Sewa Setu source data.

## 11. MCP server specification

Implement a remote, stateless MCP endpoint at `/mcp` using Cloudflare's current Agents SDK MCP handler (`createMcpHandler`) and MCP SDK v2. Use Streamable HTTP transport. The initial server is read-only and exposes service knowledge only.

Recommended tools:

| Tool | Input | Purpose |
|---|---|---|
| `search_services` | query, category?, department?, limit? | Find services |
| `get_service_details` | service_id | Return complete published metadata |
| `get_eligibility` | service_id | Return eligibility and evidence |
| `get_required_documents` | service_id, applicant_category? | Return categorized document checklist |
| `get_application_steps` | service_id | Return steps and official application URL |
| `get_service_fees` | service_id | Return published fees or explicitly unknown status |
| `get_processing_timeline` | service_id | Return official timeline or unknown status |
| `get_appeal_procedure` | service_id | Return published appeal information |
| `search_guidelines` | query, department?, limit? | Retrieve matching official passages |
| `get_department_services` | department_id | List published services for a department |
| `get_knowledge_version` | none | Return active release metadata |

MCP tools must call the same application/domain use cases as the HTTP API. Do not implement a second copy of retrieval or business rules inside MCP handlers.

Use strict Zod input schemas and bounded `limit` values. Tool results must include source URLs, section labels and verification dates. A tool must return an explicit not-found/unknown result instead of generating missing facts.

Expose read-only resources where useful:

- `sewasetu://catalog/services`
- `sewasetu://catalog/departments`
- `sewasetu://knowledge/version`

Do not add an application-submission or government-record modification tool. Any future write capability requires a separate authorization and approval design.

The MCP server is stateless and should not require a Durable Object. Test it with MCP Inspector and at least one supported remote MCP client. Do not expect opening `/mcp` in an ordinary browser to display a normal webpage.

Public access to read-only service information can be enabled initially, but add rate limiting and abuse controls. If tools later expose private or user-specific information, implement proper OAuth authentication and per-tool authorization. Do not rely on a frontend login screen to secure an MCP endpoint.

## 12. Frontend requirements

Create a responsive citizen-first UI with:

- Landing page explaining that the application is an independent guidance assistant.
- Search box for service discovery.
- Category and department filters.
- Chat interface with source citations.
- Service detail page.
- Eligibility summary.
- Mandatory/conditional/optional document checklist.
- Step-by-step application instructions.
- Fee and timeline cards with an explicit unknown state.
- Direct official service link.
- Feedback control for incorrect or outdated information.
- Language selector for Assamese, English and Hindi.
- Accessible keyboard navigation, readable contrast, mobile layouts and loading/error states.

Do not show a fee, time or document requirement as confirmed unless it comes from a published verified record. Do not use official government emblems or logos without authorization. Make the independent status of the assistant visible.

## 13. Code comments and documentation standard — mandatory

**Every functional area of the application must contain useful code comments.** This is an explicit acceptance criterion, not an optional style preference.

Claude must add comments in source code explaining:

- The purpose and responsibility of each major module/class.
- What each public function, API handler, use case and MCP tool does.
- Why important validation and security checks exist.
- The data flow between R2, retrieval, Groq and the response formatter.
- Non-obvious ranking, chunking, deduplication and release-publishing logic.
- Retry, timeout, fallback and error-handling behavior.
- Cloudflare bindings and environment variables.
- Frontend event handlers and user-visible actions where the behavior is not self-evident.
- Python extraction fallbacks, OCR detection and validation decisions.

Use TSDoc/JSDoc for exported TypeScript functions and classes. Use Python docstrings for public modules, classes and functions. Add short inline comments for non-obvious branches and edge cases.

Good comment:

```ts
/**
 * Retrieves evidence passages for one citizen question.
 * The service first uses the BM25 index so the initial deployment does not
 * require a vector database; semantic candidates may be merged when the
 * optional Workers AI embedding path is enabled.
 */
export async function retrieveEvidence(
  question: string,
  filters: RetrievalFilters,
): Promise<RetrievedChunk[]> {
  // Keep the candidate count bounded to avoid loading an entire R2 corpus.
  const candidates = await retriever.search(question, filters, 20);
  return rankAndDeduplicate(candidates).slice(0, 8);
}
```

Bad comment:

```ts
// Set question to question.
const input = question;
```

Do not comment every obvious assignment. Comments must explain intent, behavior, constraints or reasoning. Keep comments accurate when code changes. Avoid large commented-out code blocks. Do not leave unexplained TODOs, placeholder implementations or dead code in a completed phase.

## 14. Worker configuration

Use `wrangler.jsonc`. The following is an illustrative configuration; Claude must check it against the installed Wrangler schema and generated types, then complete it for the actual repository.

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "sewasetu-ai",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-11-11",
  "upload_source_maps": true,
  "assets": {
    // Vite/Cloudflare plugin supplies the build output; SPA fallback is required for client-side routes.
    "not_found_handling": "single-page-application"
  },
  "r2_buckets": [
    {
      "binding": "KNOWLEDGE_BUCKET",
      "bucket_name": "sewasetu-knowledge"
    }
  ],
  "ai": {
    // Optional: use only after enabling multilingual semantic retrieval.
    "binding": "AI"
  },
  "observability": {
    "enabled": true
  },
  "vars": {
    "APP_ENV": "production",
    "GROQ_MODEL": "REPLACE_WITH_CURRENT_SUPPORTED_MODEL",
    "SEMANTIC_SEARCH_ENABLED": "false",
    "MAX_RETRIEVAL_CHUNKS": "8"
  }
}
```

Do not put API keys in `vars`. If semantic search is not part of the first release, omit the AI binding and related code until that phase is enabled. Run `npx wrangler types` after changing bindings and use the generated `Env` type.

For the React application, use the Cloudflare Vite plugin. A newly scaffolded React + Vite Worker project may generate a build-specific output configuration. Follow the installed plugin's current conventions rather than manually maintaining conflicting `assets.directory` values.

## 15. Environment variables and secrets

### 15.1 Worker secrets

Set the Groq key using Wrangler:

```bash
npx wrangler secret put GROQ_API_KEY
```

Set only secrets that the Worker actually needs. Never commit `.dev.vars`, `.env`, API tokens or R2 credentials.

### 15.2 Local development

Create `.dev.vars` locally (do not commit it):

```dotenv
GROQ_API_KEY=replace_with_local_secret
```

Keep a safe `.dev.vars.example` file with placeholder values only.

### 15.3 GitHub Actions secrets

Configure repository secrets for the ingestion publisher:

- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`
- `CLOUDFLARE_AI_TOKEN` only if the ingestion pipeline calls Workers AI's REST endpoint for embedding generation

Use an R2 API token scoped to the required bucket and minimum read/write permissions. Do not reuse an all-account Cloudflare API token. If the workflow only needs to publish an R2 release, it must not receive a Groq key.

For the deployment workflow, use a separate Cloudflare API token with only the permissions needed to deploy Workers. Keep deployment and R2 publishing credentials separate.

## 16. R2 setup and commands

Install Node.js LTS supported by the current Wrangler release, then authenticate:

```bash
npm install
npx wrangler login
npx wrangler whoami
```

Create the R2 bucket:

```bash
npx wrangler r2 bucket create sewasetu-knowledge
npx wrangler r2 bucket list
```

If the bucket already exists, inspect and reuse it rather than creating another one. Keep the bucket private. The Worker accesses it through the `KNOWLEDGE_BUCKET` binding; do not make raw source files publicly accessible by default.

Generate types after configuring the bucket:

```bash
npx wrangler types
```

## 17. Local development and testing

Run the application using the Cloudflare Vite plugin so the Worker code executes in a local Cloudflare-compatible runtime.

```bash
npm install
npm run dev
```

Expected scripts should include equivalents of:

```json
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "npm run build && vite preview",
    "deploy": "npm run build && wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "cf-typegen": "wrangler types"
  }
}
```

Adjust the commands to the actual Vite plugin version and repo scripts. Do not claim deployment succeeded just because the local build succeeds.

Required tests:

- Service schema validation and unknown-field behavior.
- BM25 retrieval and service filtering.
- No-result and ambiguous-result handling.
- R2 release pointer lookup and missing-object handling.
- Groq timeout, rate limit and malformed response handling.
- Citation/source validation.
- Assamese, English and Hindi retrieval test cases.
- API request validation, bounded pagination and payload sizes.
- MCP tool schema validation and MCP Inspector connectivity.
- Frontend mobile responsiveness and keyboard navigation.
- Ingestion duplicate detection, PDF page attribution, OCR fallback and failed-source reporting.
- Atomic release publishing and rollback to the previous release.

Create a small approved golden test set: citizen question, expected relevant service IDs, required source chunks and forbidden unsupported claims. Test every change to the retrieval and prompt logic against it.

## 18. GitHub Actions deployment

Connect the Git repository to Cloudflare Workers Builds or use GitHub Actions with Wrangler. Use one deployment workflow for application releases and a separate workflow for knowledge ingestion.

The deployment workflow must:

1. Run on pull requests for build/type-check/test without production deployment.
2. Run on push to the protected production branch for deployment.
3. Use a locked Node version and `npm ci`.
4. Run type checking, tests and production build.
5. Deploy with Wrangler using a scoped Cloudflare deployment token stored as a GitHub secret.
6. Avoid exposing secrets in logs.

Example command for the deploy job:

```bash
npm ci
npm run typecheck
npm test
npm run build
npx wrangler deploy
```

Use the actual package manager and scripts from the repository. Pin GitHub Actions by reviewed major version or immutable commit according to repository policy.

## 19. GitHub Actions ingestion schedule

Run document ingestion on a daily schedule and allow manual execution. GitHub Actions cron uses UTC. For a daily run at approximately 03:30 India Standard Time, use `0 22 * * *` (22:00 UTC on the previous calendar date). Also provide `workflow_dispatch` for manual ingestion.

The workflow must install Python dependencies, run crawler/extractor/index builder, validate the release, then publish it to R2. Upload only after validation succeeds.

Suggested workflow outline:

```yaml
name: Ingest and publish Sewa Setu knowledge

on:
  schedule:
    # 22:00 UTC is approximately 03:30 the following day in India (UTC+05:30).
    - cron: "0 22 * * *"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: sewasetu-knowledge-publish
  cancel-in-progress: false

jobs:
  ingest:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - name: Check out approved source and ingestion code
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: "pip"
          cache-dependency-path: ingestion/requirements.txt

      - name: Install ingestion dependencies
        run: pip install -r ingestion/requirements.txt

      - name: Run extraction, normalization and index generation
        run: python ingestion/run_ingestion.py --output build/release --validate

      - name: Publish validated release to R2
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          R2_BUCKET_NAME: ${{ secrets.R2_BUCKET_NAME }}
        run: |
          # R2 supports the S3-compatible API; the endpoint is account-specific.
          aws s3 sync build/release/ "s3://${R2_BUCKET_NAME}/releases/${RELEASE_ID}/" \
            --endpoint-url "https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
```

This is a workflow outline, not a complete ready-to-run file. Claude must implement the `RELEASE_ID` creation, install/configure AWS CLI, upload verification, final `current.json` publication and rollback safeguards. `current.json` must not be updated by the initial `aws s3 sync` command. Publish that pointer with a separate final operation after verifying every release object.

For GitHub Actions production use, pin action versions according to the security policy and consider pinning to commit SHAs. Store workflow secrets in GitHub repository/environment settings. Never print credentials or signed request headers.

## 20. Admin and content review approach without a database

For the initial release, use a Git-based review workflow rather than a mutable admin database:

- Extracted records with uncertain fields are marked `draft`.
- Reviewers inspect generated JSON, source excerpts and validation report in a pull request or workflow artifact.
- Approved records are merged to the protected branch.
- The publishing workflow creates a new immutable R2 release.
- The active knowledge pointer is changed only after successful validation.

A future admin dashboard may display source status, extraction errors, draft records and release history. Protect it with Cloudflare Access or an equivalent server-side authentication mechanism. Do not assume that hiding the admin link protects the routes. Keep any content-editing capability disabled until it has a secure, auditable workflow.

## 21. Security, privacy and reliability

- Keep Groq and Cloudflare credentials server-side only.
- Keep the R2 bucket private.
- Validate every API and MCP input.
- Add rate limiting and request-size limits to public endpoints.
- Set request timeouts for external fetches and LLM calls.
- Do not log citizen questions together with personally identifying or sensitive details by default.
- Avoid collecting personal details unless a necessary, documented feature is approved.
- Never ask users to share OTPs, passwords, full Aadhaar numbers, bank details or authentication credentials.
- Do not crawl or expose application-specific private data.
- Add a visible independent-service disclaimer.
- Preserve source attribution and content freshness metadata.
- Use Cloudflare Access to protect private admin areas; public citizen routes should not be protected by the admin login policy.
- Apply a separate authentication and OAuth authorization design before any private-user-data MCP tool is introduced.
- Sanitize source text before including it in prompts. Retrieved content is data, never executable instructions.
- Treat prompt injection inside scraped pages and PDFs as untrusted content.
- Add monitoring for Worker errors, Groq errors, missing R2 objects, stale content and ingestion failures.
- Set a maximum context size and model output size to control cost and prevent oversized requests.

## 22. Performance and plan-limit considerations

Check current Cloudflare plan limits before deployment. Workers Free has a limited CPU budget per request; heavier retrieval, large JSON parsing and full-corpus vector scans may exceed it. Keep the initial BM25 search index compact and sharded. Load only the relevant index partitions and top-ranked passages. Benchmark with realistic corpus sizes.

Do not load all PDFs, all chunks or the full vector corpus into memory for every request. Cache the active manifest and bounded index shards where appropriate, while ensuring new releases become visible after publication. Cache keys must include release IDs so a new release cannot accidentally reuse stale cached index content.

If corpus size or traffic grows, first optimize index sharding, retrieval filtering and cache behavior. Upgrade the Worker plan if required. A future vector database is a separate optional architectural change, not part of this implementation.

## 23. Deployment procedure

### Step 1 — Create the Cloudflare project

Use the current Cloudflare React + Vite project generator:

```bash
npm create cloudflare@latest -- sewasetu-ai --framework=react
cd sewasetu-ai
```

Choose TypeScript and Git when prompted. Review the generated files. Do not overwrite useful existing code if this is being applied to an existing repository.

### Step 2 — Install application dependencies

Add the Cloudflare Vite plugin and Wrangler if the scaffold did not include them. Add the Hono/router, Zod, Groq client or a small typed fetch adapter, and the Cloudflare MCP dependencies documented for the current SDK release.

For the MCP component, follow Cloudflare's current documented pattern using:

- `agents`
- `@modelcontextprotocol/server` (compatible SDK v2 release)
- `zod`

Check the `agents` package peer dependency requirements and pin a mutually compatible version set. Do not mix legacy `McpAgent` code with the new stateless `createMcpHandler` implementation.

### Step 3 — Configure R2 and Worker bindings

Create the private R2 bucket, configure `KNOWLEDGE_BUCKET`, optionally configure `AI`, then run `npx wrangler types`.

### Step 4 — Configure secrets

```bash
npx wrangler secret put GROQ_API_KEY
```

Configure GitHub Actions ingestion and deployment secrets separately.

### Step 5 — Build the application

```bash
npm run typecheck
npm test
npm run build
```

Resolve all errors before deployment.

### Step 6 — Publish the first knowledge release

Run ingestion manually from GitHub Actions or locally. Review the report and source metadata. Publish a first release containing only verified records. Make `current.json` point to that release only after validation has passed.

### Step 7 — Deploy Worker

```bash
npx wrangler deploy
```

### Step 8 — Verify public routes

Check:

- `/` returns the React application.
- `/health` returns a non-sensitive health response.
- `/api/v1/catalog` returns published catalogue records.
- `/api/v1/search?q=land` returns relevant official service results.
- `/api/v1/chat` returns a grounded response with citations.
- `/mcp` responds to an MCP Inspector connection and lists expected tools.
- An unknown service ID returns a structured not-found response.
- The R2 bucket cannot be browsed anonymously.

### Step 9 — Add custom domain

After successful testing, attach the custom domain to the Worker in Cloudflare. Verify HTTPS, DNS, API routes, MCP route and SPA routing.

### Step 10 — Enable scheduled ingestion

Enable the GitHub Actions schedule only after one manual run has succeeded. Monitor workflow reports and the active release timestamp. Alert or display a warning if the knowledge release becomes stale.

## 24. Acceptance criteria

The implementation is complete only when all of the following are true:

- [ ] React application is deployed as Cloudflare Worker static assets.
- [ ] API and MCP endpoints are served by the Worker.
- [ ] R2 bucket is private and bound to the Worker.
- [ ] No traditional database or Vectorize is introduced.
- [ ] Service catalogue schema is validated.
- [ ] Knowledge release uses immutable versioned paths.
- [ ] `current.json` changes only after successful release verification.
- [ ] Ingestion can run manually and on a daily schedule.
- [ ] PDF text extraction and scanned-PDF OCR fallback work.
- [ ] Every published service includes official source references.
- [ ] Unknown fees, timelines and requirements are not guessed.
- [ ] RAG responses cite evidence and disclose uncertainty.
- [ ] Groq credentials remain server-side.
- [ ] MCP tools call shared application use cases and return sources.
- [ ] MCP is tested with MCP Inspector.
- [ ] Assamese, English and Hindi test cases are evaluated.
- [ ] Rate limiting, input validation, timeouts and error handling are implemented.
- [ ] Unit and integration tests pass.
- [ ] Meaningful code comments and TSDoc/docstrings exist in all functional areas.
- [ ] Deployment and ingestion workflows do not expose secrets.
- [ ] Rollback to the previous R2 release is documented and tested.

## 25. Claude implementation instructions

Use the following prompt when handing this specification to Claude Code:

> Read this entire `SEWA_SETU_AI_CLOUDFLARE_DEPLOYMENT.md` before writing code. Treat it as the implementation contract.
>
> First inspect the current repository and identify what already exists. If the repository is empty, scaffold the React + TypeScript + Vite application using the current Cloudflare Workers Vite plugin. If code already exists, preserve working modules and adapt them instead of replacing them wholesale.
>
> Implement the system incrementally in the phases below. Do not create PostgreSQL, MySQL, MongoDB, D1, KV, Durable Objects or Vectorize. Use R2 for versioned knowledge files. Keep ingestion in Python/GitHub Actions and keep the Worker request path lightweight.
>
> **Mandatory code-comment requirement:** Add meaningful explanatory comments throughout the application. Use TSDoc/JSDoc for exported TypeScript modules, classes, public functions, API handlers, RAG use cases and MCP tools. Use Python docstrings for public ingestion modules and functions. Add inline comments for non-obvious validation, security, ranking, retry, OCR, caching and release-publishing logic. Comments must explain purpose, constraints and reasoning; do not add useless comments that merely restate a line of code.
>
> Follow SOLID principles and dependency inversion. Put business rules in application/domain packages and define interfaces (ports) for the knowledge repository, retrieval engine, LLM provider, embedding provider and source extractor. Implement R2, Groq and Workers AI as infrastructure adapters. The HTTP API and MCP tools must invoke the same use cases.
>
> Build and test the BM25 retrieval path first. Add Workers AI multilingual embeddings as an optional second phase only after testing model availability, output dimensions, query latency, cost and Assamese/English/Hindi relevance. Do not assume that Groq is an embedding provider. Do not add a vector database to avoid optimizing the problem prematurely.
>
> Implement ingestion so it discovers only approved official sources, respects crawl policies, records retrieval metadata, extracts HTML/PDF text, uses OCR only for scanned pages, normalizes service records, validates all claims against sources, creates chunks/indexes and publishes an immutable R2 release. Update `current.json` only after the full release has passed verification.
>
> Implement the remote MCP endpoint with Cloudflare's current stateless `createMcpHandler` pattern and Streamable HTTP. Register the read-only tools specified in this document. Make tools share the same application services as the HTTP API. Add strict input/output schemas and source references.
>
> Implement the React citizen UI with service discovery, filters, chat, citations, eligibility and document checklists, direct official links and Assamese/English/Hindi language selection. Do not represent the product as an official government portal.
>
> Add GitHub Actions workflows for build/test/deploy and for daily/manual ingestion. Configure secrets through Cloudflare and GitHub settings only; never commit secrets. Keep the R2 bucket private.
>
> After each phase, run formatting, type checking, unit tests and relevant integration tests. Fix errors before proceeding. Do not leave stubs, fake service content, mock success responses in production code, or unimplemented acceptance criteria. Use placeholder service data only in tests and label it clearly.
>
> At the end, provide: (1) implemented file tree, (2) setup commands, (3) Cloudflare resources and bindings created/configured, (4) required secrets, (5) deployment commands, (6) ingestion run instructions, (7) MCP connection details, (8) test results, (9) known limitations and costs, and (10) a checklist of acceptance criteria. Never claim a Cloudflare deployment has happened unless the deployment command was actually run and succeeded.

## 26. Implementation phases

| Phase | Deliverable | Exit condition |
|---|---|---|
| 1 | Cloudflare React/Worker foundation, R2 binding and health route | Local Worker and SPA work |
| 2 | Schemas, R2 repository and release manifest | Reads versioned sample release from R2 |
| 3 | Python crawler and HTML/PDF extraction | Produces auditable extraction report |
| 4 | Normalization, validation, chunks and BM25 | Validated searchable release generated |
| 5 | RAG use case and Groq integration | Grounded answer with citations and no guessing |
| 6 | Citizen UI | Search, chat and service details work on mobile |
| 7 | MCP endpoint | Inspector lists and successfully invokes read-only tools |
| 8 | GitHub Actions publishing and deployment | Manual and scheduled workflows work |
| 9 | Optional Workers AI embeddings | Evaluated multilingual semantic search works within limits |
| 10 | Security, observability and release rollback | Acceptance checklist passes |

Do not start with the optional embedding/vector retrieval phase before the BM25 pipeline and evidence citations are reliable.

## 27. Official references

Use these official references during implementation. Re-check them because Cloudflare and SDK configuration may change.

- Cloudflare React + Vite on Workers: <https://developers.cloudflare.com/workers/framework-guides/web-apps/react/>
- Cloudflare Workers Static Assets: <https://developers.cloudflare.com/workers/static-assets/>
- Wrangler configuration: <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Workers platform limits: <https://developers.cloudflare.com/workers/platform/limits/>
- R2 Workers API: <https://developers.cloudflare.com/r2/get-started/workers-api/>
- R2 S3-compatible API: <https://developers.cloudflare.com/r2/api/>
- Cloudflare Cron Triggers: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- Cloudflare Workers AI `bge-m3`: <https://developers.cloudflare.com/workers-ai/models/bge-m3/>
- Workers AI Wrangler binding: <https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/>
- Cloudflare remote MCP server guide: <https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/>
- Cloudflare MCP handler API: <https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/>
- Cloudflare Access for Workers: <https://developers.cloudflare.com/workers/configuration/cloudflare-access/>
- Groq API reference: <https://console.groq.com/docs/api-reference>
- Groq model catalogue: <https://console.groq.com/docs/models>

---

**End of implementation specification.**
