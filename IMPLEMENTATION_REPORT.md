# Implementation report

Status date: 11 Nov 2026. Specification: [docs/SEWA_SETU_AI_CLOUDFLARE_DEPLOYMENT.md](docs/SEWA_SETU_AI_CLOUDFLARE_DEPLOYMENT.md).

**Bottom line:** the full application is implemented and verified locally — Worker (REST + MCP), React citizen app and admin panel, Python ingestion with a *real* crawl of the portal, R2 release publishing/rollback logic, CI workflows. **Nothing has been deployed to Cloudflare and nothing that needs Groq, R2, Workers AI, Cloudflare Access or GitHub credentials has been run for real** (none were available). Those items are marked below and in [TESTING.md](TESTING.md).

## Real-data ingestion results (live portal, polite crawl, 1 req/s)
Two full runs against <https://sewasetu.assam.gov.in/> published into a local directory "bucket" (same code path as R2 uploads):

| | Run 1 | Run 2 (after extractor fix) |
|---|---|---|
| Services discovered / extracted / failed | 919 / 919 / 0 | 919 / 919 / 0 |
| Departments · categories | 66 · citizen 621, eodb 280, utility 13, schemes 5 | same |
| Services with documents / steps / fees / processing time | 100 / 902 / 660 / 0 | **771 / 902 / 736 / 656** (341 with a parsed number) |
| Services with structured eligibility / appeal | — | 27 / 0 (the portal rarely publishes them; reported as unavailable, never guessed) |
| Document labels | — | 129 labelled mandatory/optional/conditional, 7286 `unspecified` (no label on the portal) |
| Chunks · sources | 4069 · 977 | 5981 · 977 |
| PDFs discovered / extracted / failed / OCR | 61 / 54 / 7 / 8 | same |
| Change detection | 919 new | **919 unchanged** (0 new raw snapshots archived) |
| Validation (JSON-Schema + spec 8.3 rules) · Worker Zod parse (`validate-release.ts`) | passed · OK | passed · OK |

* The first run exposed a second Requirements-tab layout (`Supporting Documents : … Stipulated Time Limit : … Fees : …`) used by ~700 services; the extractor was rewritten for it and regression fixtures added (see INGESTION.md).
* The 7 PDF failures are real and reported: one HTTP 404 on `eodb.assam.gov.in`, and six links the policy correctly refused (plain `http://` or an unapproved host `www.apdcl.org`). No access restriction was bypassed.
* Real-data checks through the Worker running locally (workerd + emulated R2): smoke test passes, English/Hindi/Assamese service search works, admin approve → public service becomes *verified* and chat reports `confirmed`, upload accepted / fake PDF rejected, ingestion logs and release listing work, rollback/roll-forward on the real store works, official MCP client SDK lists 12 tools and calls them over Streamable HTTP.
* Every record is `draft`. **No content has been human-verified** — an administrator must review before production (`SERVE_UNREVIEWED_CONTENT=false` hides drafts).

## Test results (latest run)
| Suite | Result |
|---|---|
| `npm run typecheck` (Worker/packages + React) | pass |
| `npm test` — Vitest (retrieval, RAG, Groq mock, R2, REST, auth, admin, MCP, feedback, Python-release compat, React/jsdom) | **117 passed** (10 files) |
| `npm run test:py` — pytest (extraction, PDF/OCR, crawler policy, pipeline, publish/rollback, validator, embeddings) | **63 passed** |
| `npm run build` (Vite: SPA + Worker) | pass (Worker 225 KiB gzip) |
| `wrangler deploy --dry-run` (production and staging configs) | pass |
| Live-data scripts: `validate-release`, `local-smoke-test`, `mcp-client-check` | pass |
Integration tests that need credentials were **not** run and are not claimed.

## Phase-wise status (spec section 26)
| # | Phase | Status | Notes |
|---|---|---|---|
| 1 | Cloudflare React/Worker foundation, R2 binding, health | **Completed** (local) | `vite dev` runs SPA + Worker + emulated R2; `/health` works. Not deployed. |
| 2 | Schemas, R2 repository, release manifest | **Completed** | Zod → JSON Schema export; release-keyed caching; fixture + real releases read from R2 emulation. |
| 3 | Python crawler and HTML/PDF extraction | **Completed** | Real crawl: 919 services, 54 PDFs (8 with OCR), auditable report. OCR quality heuristic is simple (see limitations). |
| 4 | Normalisation, validation, chunks, BM25 | **Completed** | Validated, searchable release; Python↔TS tokenizer/hash parity tests. |
| 5 | RAG use case and Groq integration | **Completed (local)** | Verified with the real Groq API (`openai/gpt-oss-120b`) on the 919-service data: grounded fee/document answers with correct figures, English/Hindi/Assamese replies, out-of-scope and prompt-injection questions refused. Real-model testing found and fixed: full-width `【S1】` citations, reasoning-token budget, and an invented "a few days to weeks" timeline (now blocked by a prompt rule + missing-section guard). Not yet measured: quality over a curated question set, latency/cost. |
| 6 | Citizen UI | **Completed** (jsdom-tested) | Not exercised in a real browser/device; no visual QA or axe audit. |
| 7 | MCP endpoint | **Partially completed** | 12 tools/3 resources; tested via JSON-RPC and the official client SDK locally. **MCP Inspector and a deployed endpoint not tested.** |
| 8 | GitHub Actions publishing and deployment | **Partially completed** | Three workflows written and YAML-validated; the publish logic is tested against a local store. **No workflow has run** (needs a GitHub repo + secrets); S3/R2 client tested only via an injected fake. |
| 9 | Optional Workers AI embeddings | **Partially completed** | Provider ports, REST/AI adapters, int8 shard format, bounded hybrid retrieval implemented and unit-tested with fakes. **Not evaluated with real bge-m3**; ships disabled. |
| 10 | Security, observability, rollback | **Partially completed** | Auth (Access JWT + token), validation, limits, rate limiting, redaction, rollback (UI, CLI, workflow) done and tested. Not done: global rate limiting (WAF), alerts/monitoring rules, Cloudflare Access setup, dependency scanning. |
| — | Admin panel (task brief §8) | **Completed** | Review/approve/reject (bulk), corrections with evidence, PDF upload, ingestion logs/failures, last-verified dates, rebuild trigger (needs GitHub token), rollback, feedback inbox. |

## Acceptance criteria (spec section 24)
- [ ] React app deployed as Worker static assets — *built and dry-run validated; not deployed*
- [ ] API and MCP served by the Worker — *yes locally; not deployed*
- [ ] R2 bucket private and bound — *configured in `wrangler.jsonc`; bucket not created*
- [x] No traditional database or Vectorize
- [x] Service catalogue schema validated (Zod + JSON Schema, both sides)
- [x] Immutable versioned release paths
- [x] `current.json` changes only after verified upload (tested incl. failure injection)
- [ ] Ingestion runs manually and daily — *workflow written, never run on GitHub*
- [x] PDF text extraction and scanned-PDF OCR fallback (tested; 8 real OCR PDFs)
- [x] Every published service has official source references (validator rule; real data passes)
- [x] Unknown fees/timelines/requirements are not guessed
- [x] RAG responses cite evidence and disclose uncertainty (mocked LLM)
- [x] Groq credentials stay server-side
- [x] MCP tools call shared use cases and return sources
- [ ] MCP tested with MCP Inspector — *official client SDK only*
- [ ] Assamese/English/Hindi evaluation — *retrieval smoke-tested on real data via the lexicon; no curated golden set; no real-model evaluation*
- [x] Rate limiting, validation, timeouts, error handling
- [ ] Unit and integration tests pass — *unit + local integration pass; credentialed integration not run*
- [x] Comments/TSDoc/docstrings in all functional areas
- [x] Workflows do not expose secrets (secrets only via `secrets.*`, scoped tokens documented)
- [ ] Rollback tested — *tested on a local store and via the Worker admin route against fakes; not on real R2*

## Outstanding limitations
1. **No credentialed verification** (Groq now done locally): R2 (real S3 API), Workers AI, Cloudflare Access, GitHub Actions, MCP Inspector, deployment. Groq was tested only locally with the owner's key; model default changed to `openai/gpt-oss-120b` because `llama-3.3-70b-versatile` is not available to that account.
2. **No human-verified content.** All 919 services are `draft`; production hides them until approved. Bulk approval exists but should follow an actual check.
3. **Extraction is deterministic, layout-specific**: three Requirements/Guidelines layouts are handled; others fall back to verbatim notes. 148 services still have no structured documents (many publish none). Most documents carry no mandatory/optional label on the portal (`unspecified`). Free-text guidance (~17 services) is searchable but not structured. Appeal/grievance content is only available as general guideline chunks.
4. **Retrieval relevance** is keyword-based. The coverage floor + model `NO_ANSWER` rule reduce irrelevant answers but thresholds are calibrated on ~15 hand-written questions; the cross-lingual lexicon (~60 words) and the Hindi/Assamese UI strings are unreviewed drafts. Semantic retrieval (the real fix for Assamese/Hindi) is untested.
5. **PDFs**: only PDFs linked from approved pages on allow-listed https hosts; 7 failed (see above). OCR quality is a heuristic (no engine confidence); poor-OCR pages are withheld from the corpus.
6. **Rate limiting is per Worker isolate**; no WAF/Turnstile. No monitoring/alerting rules (only structured logs and `/health` staleness).
7. **No browser/device QA**: layouts, contrast and keyboard flow are designed for WCAG but verified only through component tests.
8. R2 `sources/` raw snapshots grow with every changed page (≈64 MB for the first full crawl); add an R2 lifecycle rule if needed.
9. The Worker's admin "Rebuild" requires `GITHUB_REPO` + a dispatch token; until set it reports `not_configured`.
10. Not done by choice: no formatter/linter configuration; commits were not made (repository is initialised with nothing committed).

## What you need to do next
1. Create the R2 buckets, secrets and (recommended) Cloudflare Access app — [DEPLOYMENT.md](DEPLOYMENT.md).
2. Put your contact address in `ingestion/config/sources.yaml` and set `GITHUB_REPO` in `wrangler.jsonc`.
3. Push to GitHub, add secrets, run *Ingest and publish* once, review the report, approve services in `/admin`.
4. Deploy staging, run `scripts/local-smoke-test.ts <url> --chat`, MCP Inspector, and the manual checklist in TESTING.md.
5. Have native speakers review the Hindi/Assamese strings and the lexicon; curate a golden question set from verified content before enabling semantic retrieval.

## Project structure
See [README.md](README.md) (layout) and [ARCHITECTURE.md](ARCHITECTURE.md) (layers, R2 layout). ≈10.5k lines of TypeScript/Python plus 11 Markdown documents.
