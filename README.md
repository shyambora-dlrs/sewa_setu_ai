# Sewa Setu AI

An **independent** citizen-guidance assistant for Assam government services. It helps people find a service on the
[Sewa Setu portal](https://sewasetu.assam.gov.in/) and understand eligibility, documents, steps, fees, timelines and appeal routes —
with the official source and a verification status on every answer. It is **not** an official Government of Assam service and
never submits applications or guarantees eligibility.

* **Citizen app** (React + TypeScript): service browser and search, service pages with a document checklist, grounded chat assistant, Assamese / Hindi / English UI, mobile-first and accessible.
* **Admin panel** (`/admin`): review extracted services, approve/reject (bound to content hash), evidence-backed corrections, upload official PDFs, ingestion logs and failures, rebuild trigger, release rollback.
* **API** (Cloudflare Worker, Hono): `/api/v1/*` — see [API_DOCUMENTATION.md](API_DOCUMENTATION.md).
* **MCP server** (`/mcp`, Streamable HTTP, read-only): 12 tools + 3 resources — see [MCP_DOCUMENTATION.md](MCP_DOCUMENTATION.md).
* **Knowledge store**: versioned JSON in a private **Cloudflare R2** bucket. **No database** of any kind.
* **LLM**: Groq (replaceable adapter). Answers are grounded in retrieved official text (BM25, optional semantic stage) and never invent fees, documents, eligibility or timelines.
* **Ingestion** (Python, GitHub Actions): crawls the portal politely, extracts HTML and PDFs (OCR only for scanned pages), validates, chunks, indexes and publishes an immutable release.

## Documentation
[ARCHITECTURE](ARCHITECTURE.md) · [SETUP](SETUP.md) · [DEPLOYMENT](DEPLOYMENT.md) · [INGESTION](INGESTION.md) · [RAG_DOCUMENTATION](RAG_DOCUMENTATION.md) ·
[MCP_DOCUMENTATION](MCP_DOCUMENTATION.md) · [API_DOCUMENTATION](API_DOCUMENTATION.md) · [SECURITY](SECURITY.md) · [TESTING](TESTING.md) ·
[IMPLEMENTATION_REPORT](IMPLEMENTATION_REPORT.md) (phase status, results, limitations) · spec: [docs/SEWA_SETU_AI_CLOUDFLARE_DEPLOYMENT.md](docs/SEWA_SETU_AI_CLOUDFLARE_DEPLOYMENT.md)

## Quick start
```bash
npm ci && python3 -m pip install -r ingestion/requirements.txt
cp .dev.vars.example .dev.vars                       # add GROQ_API_KEY and ADMIN_API_TOKEN
npm run ingest -- --max-services 25                  # real, polite crawl of the portal into build/release
npm run seed:local && npm run dev                    # http://localhost:5173  (admin: /admin)
npm run check                                        # typecheck + tests + build
```

## Repository layout
```
apps/web/                React SPA (citizen + admin)         worker/        Worker: routes, MCP, middleware, adapters
packages/shared/         Zod schemas, constants, tokenizer    packages/domain/       errors, ports, visibility rules
packages/retrieval/      BM25, hybrid retrieval, ranking      packages/application/  use cases, RAG, DTOs, container
ingestion/               Python pipeline + tests + config     knowledge-schemas/     JSON Schemas exported from Zod
scripts/                 export-schemas, validate-release, seed-local-r2, smoke test
tests/                   Vitest suites (+ fixtures/helpers)   .github/workflows/     deploy, ingest/publish, rollback
wrangler.jsonc           Worker config (production + staging) docs/                  the implementation specification
```

## Content policy
Production content comes only from the ingestion pipeline (official sources). Anything in `tests/` or `ingestion/tests/fixtures/` is synthetic and labelled `TEST FIXTURE`. Extracted records are `draft` until an administrator verifies them; unknown data is shown as "not published", never guessed.

## Status
See [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md). In short: everything that can be built and verified without Cloudflare/Groq/GitHub credentials is implemented and tested; **nothing has been deployed** and live Groq, R2, Workers AI, MCP-Inspector and Access integrations are untested for lack of credentials.
# sewa_setu_ai
