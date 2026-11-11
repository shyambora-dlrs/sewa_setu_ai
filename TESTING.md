# Testing

## Commands
```bash
npm run typecheck     # tsc for the Worker/packages and for the React app
npm test              # Vitest: Worker, retrieval, RAG, MCP, auth, admin, API, frontend (jsdom)
npm run test:py       # pytest: ingestion (extraction, PDF/OCR, crawler policy, pipeline, publishing, validator)
npm run build         # Vite build of SPA + Worker
npm run check         # all of the above
npx tsx scripts/validate-release.ts build/release   # parse a real release with the Worker's Zod schemas
npx tsx scripts/local-smoke-test.ts http://localhost:5173 [--chat]   # read-only smoke test of a running instance
npm run mcp:check -- http://localhost:5173/mcp                        # official MCP client SDK against a running instance
python3 ingestion/tests/make_fixture_release.py                       # regenerate the Python-built fixture release used by the TS compat test
```

## What the automated tests cover
| Area | Where |
|---|---|
| Service metadata validation / unknown-field behaviour | `ingestion/tests/test_normalize_chunk_index.py`, `test_publish_validate.py` (validator), `scripts/validate-release.ts` |
| HTML extraction (directory, service page, guideline pages, conditional documents, fees) | `ingestion/tests/test_html_extraction.py` |
| PDF extraction, page attribution, OCR only for scanned pages, corrupt PDFs | `ingestion/tests/test_pdf.py` (OCR test runs when `tesseract` is installed) |
| Normalisation, content hashing, duplicate detection | `test_normalize_chunk_index.py` |
| Chunk generation (never splits an item, fact→chunk links) | `test_normalize_chunk_index.py` |
| BM25 + tokenizer parity (Python index ⇄ TS query) | `tests/tokenizer-retrieval.test.ts`, `ingestion/tests/test_tokenizer.py` |
| Semantic retrieval (fake embedding provider, model mismatch, outage fallback) | `tests/tokenizer-retrieval.test.ts` |
| RAG context construction, ranking, grounding, citations, injection, degradation | `tests/tokenizer-retrieval.test.ts`, `tests/rag.test.ts` |
| Groq client with mocked HTTP (retry, Retry-After, timeout, malformed, no body echo) | `tests/groq.test.ts` |
| MCP tool execution, schema validation, tool allow-list, resources | `tests/mcp.test.ts` |
| REST endpoints, pagination bounds, error envelope, rate limiting, payload limits | `tests/api.test.ts` |
| Authentication/authorization (Access JWT incl. attack cases, token, allow-list) | `tests/auth.test.ts` |
| Admin review, stale approvals, bulk, uploads, overrides, logs, rollback | `tests/admin.test.ts` |
| R2 repository (pointer, missing/corrupt objects, release-keyed caching) | `tests/r2-repository.test.ts` |
| Crawler policy (allow-list, robots, throttle, retries, redirects, CAPTCHA, 304) | `ingestion/tests/test_fetcher.py` |
| Python-built release readable/searchable by the Worker code (cross-language contract) | `tests/python-release-compat.test.ts` |
| Atomic publish (`current.json` last), failed upload, verification failure, rollback, retention | `ingestion/tests/test_publish_validate.py` |
| Failed-source reporting, carry-forward, change detection, admin uploads/overrides/reviews end to end | `ingestion/tests/test_pipeline.py` |
| Frontend: checklist, unknown states, language switch, chat (no secrets, errors, degraded) | `tests/web/frontend.test.tsx` |

All service content in tests is synthetic and labelled `TEST FIXTURE` (`tests/helpers/fixture-release.ts`, `ingestion/tests/fixtures/`). It is never shipped or presented as real data.

## What is NOT covered by automated tests (requires credentials or a deployment)
* Real Groq calls, Workers AI embeddings, real R2 (the S3 client and R2 binding are tested through fakes/injected clients).
* Deployment itself, Cloudflare Access login, `wrangler deploy`, GitHub Actions runs.
* MCP Inspector and third-party client interop against a deployed URL.
* Assamese/Hindi answer quality and bge-m3 relevance/latency; frontend mobile layout and keyboard flow in a real browser (only jsdom checks of roles/labels/states).
* Load/CPU-limit benchmarking on Workers Free with the real corpus size.

## Manual end-to-end checklist

### Citizen assistant
- [ ] Open `/`: independence banner visible; language switch changes UI to हिन्दी and অসমীয়া and persists after reload; `<html lang>` updates.
- [ ] Home search "income certificate" → results; open a service.
- [ ] Service page: every section shows data **or** "Not published in the official source" (never a blank card or a guessed value); fee amounts match the official page; "Apply on the official portal" opens the portal in a new tab.
- [ ] Checklist: mandatory / only-in-some-cases (with the condition text) / optional are separate; ticking persists after reload; Print produces a clean list.
- [ ] Ask the assistant: "What documents are required for an income certificate?" → answer cites `[S1]…`, sources list shows official URLs, verification badge matches the service status, disclaimer present.
- [ ] Ask something not covered ("What is the fee for a spaceport licence?") → "could not find official information", no sources, no invented fee.
- [ ] Ask in Hindi and in Assamese → reply in that language, sources relevant.
- [ ] Paste a fake Aadhaar number/OTP → warning/redaction; confirm (Workers logs) the number never appears.
- [ ] "What is the status of my application?" → refers to the portal Track option.
- [ ] Disable network / set a wrong `GROQ_API_KEY` → "AI summary unavailable" plus passages, UI still usable.
- [ ] Keyboard only: Tab reaches skip link, nav, language buttons, filters, checklist, chat; Enter sends; focus rings visible. Test at 360 px width and with 200 % zoom.
- [ ] Report incorrect information → thank-you; entry visible in admin Feedback.

### Administrator panel
- [ ] `/api/v1/admin/services` without credentials → 401; `/admin` shows the sign-in form; wrong token rejected; correct token (or Access login) works.
- [ ] Services list: counts per status, filters (status/category/warnings/search) work; open a draft.
- [ ] Compare record with the official page via "Open official page"; approve → public service page shows "Reviewed by an administrator" (production mode: service appears in catalogue); reject → disappears; reset → draft.
- [ ] Bulk approve asks for confirmation and updates the selection.
- [ ] Save a correction without evidence URL → rejected; with evidence → "pending rebuild" banner; after rebuild the corrected text is cited with the evidence URL and the record needs re-approval.
- [ ] Upload a non-PDF renamed to `.pdf` → rejected; upload a real PDF → listed; after rebuild its text is searchable and cited.
- [ ] Ingestion screen: latest release, totals, extraction failures, unavailable-field counts; "Trigger rebuild" starts the workflow; "Activate this release" rolls back and `/api/v1/system/version` reflects it.

### MCP client
- [ ] MCP Inspector → Streamable HTTP → `/mcp`: 12 tools and 3 resources listed; all read-only.
- [ ] `search_services` → `get_required_documents` → verify groups and sources; `get_service_fees` on a service without fees → `not_published`.
- [ ] Invalid input (limit 500, `service_id` = `../x`) → validation error, no crash.
- [ ] Add to Claude Code / Claude Desktop (see MCP_DOCUMENTATION.md) and ask a service question; the client cites the returned URLs.
- [ ] Send > 60 requests/min from one client → 429.
