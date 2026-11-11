# Ingestion pipeline

Location: [`ingestion/`](ingestion) (Python 3.12). Entry point: `ingestion/run_ingestion.py`. Runs on GitHub Actions or locally; never in the Worker.

## Stages (`sewasetu_ingest/pipeline.py`)
1. **Discover** — fetch each directory page in `config/sources.yaml` (`/site/online/{citizen,eodb,schemes,utility}` and `/site/online/service-group/*`), parse the `Department | Service | Apply` tables into service references, drop duplicate URLs. The first directory that lists a service decides its category.
2. **Fetch & extract services** — each `/site/service-apply/<slug>` page is parsed (`extractors/html_service.py`): title, department badge, apply link, ordered application steps (Guidelines tab), documents with their `[Mandatory]`/`[Optional]`/conditional labels, fee lines and explicit eligibility/time-limit/appeal/grievance sections (Requirements tab). The live portal uses **three layouts**, all handled: (A) bold headings + lists with `[Mandatory]` labels (~100 services), (B) flat `Supporting Documents : … / Stipulated Time Limit : … / Fees : …` paragraphs or lists (~700 services; `N/A` values are kept only as a note, `NIL` fees as a fee line without amount), and (C) free-text guidance in the Guidelines tab (kept verbatim and chunked as general guidance, not forced into fields).
3. **Guideline pages** — appeal, FAQ, documents and policy pages become general guideline chunks; linked downloads (`*.pdf`, `/site/docs_download?p=…`) are queued.
4. **PDFs** — fetched from allow-listed official hosts, text extracted per page with PyMuPDF; **only** pages with (almost) no text go to Tesseract OCR; OCR pages are marked, scored with a heuristic quality measure and withheld from the corpus (and reported) when poor. PDFs linked from a service page are attached to that service as an additional source.
5. **Administrator input** (read from R2 `admin/`): uploaded PDFs are extracted like any other PDF (marked `admin_upload`); evidence-backed corrections are applied and cited with the evidence URL; approve/reject decisions are baked in (approval only when the content hash still matches).
6. **Duplicates / changes** — duplicate canonical URLs, services with identical content hash and PDFs with identical bytes are reported; the source registry classifies each source as new / changed / unchanged (services by the hash of their *extracted content*, because raw HTML can differ per request) and lists sources that disappeared.
7. **Chunk & index** — structure-aware chunks (`chunkers/chunker.py`), BM25 sharded index (`indexers/bm25.py`), optional embeddings (`embeddings/`).
8. **Validate** (`validators/validate.py`) — JSON-Schema validation of every record (schemas exported from the Zod definitions), spec 8.3 rules (every service has an https official source; every fee / processing time / mandatory document has a supporting chunk; no duplicate ids), referential integrity, index consistency, checksums.
9. **Publish** (`publisher/release.py`) — upload every object under `releases/<id>/` with a sha256 metadata tag, verify each object, **then** write `current.json`; keep the newest 4 releases (current + 3 rollback targets) and prune older ones.

## What is never done
* No LLM is used for extraction, so no unsupported facts can enter the corpus. Missing data stays `null`/empty/`not_published` and is counted under `unavailable_fields` in the report.
* A label like `[Mandatory (incase of applying from PFC/CSC)]` becomes a **conditional** document with the verbatim condition. Unlabelled documents are `unspecified`.
* Prose such as "processing within 15 working days" in a guideline paragraph is **not** promoted to a processing time; only an explicit time-limit section is.
* Extraction never marks anything `verified`.

## Crawl policy (`config/crawl-policy.yaml`, `crawler/http.py`)
Allow-listed hosts only (every redirect hop re-checked); `robots.txt` honoured (404 ⇒ no restrictions, 5xx ⇒ disallow all); ≥ 1 s between requests per host; 30 s timeout; 3 retries with exponential backoff for timeouts/5xx; `Retry-After` > 30 s is not waited out; ETag/Last-Modified conditional requests when a cached body exists; size limits (3 MB HTML, 30 MB PDF); descriptive User-Agent (**set your contact address** in `sources.yaml`). 401/403 and CAPTCHA-looking pages are recorded as failures, never bypassed. If the portal is unreachable: nothing is published (all directories failed ⇒ abort), and administrators can upload officially obtained PDFs through the admin panel; additional sources can be added to `sources.yaml` (`directories`, `guideline_pages`, `extra_pdfs`).

## Failure handling
Every failure is appended to the report (`url`, `stage`, `error`) and the run continues. A service whose page fails to fetch is **carried forward** from the active release (with a warning) so a transient outage does not delete a published service. The run aborts (exit 2, nothing published) when no directory is reachable or the share of failed service pages exceeds `--max-failure-ratio` (default 10 %).

## CLI
```bash
python3 ingestion/run_ingestion.py --output build/release --validate                 # build + validate locally
python3 ingestion/run_ingestion.py --output build/release --validate --publish --store local:build/store   # full flow into a local directory "bucket"
python3 ingestion/run_ingestion.py --output build/release --validate --publish --store r2                   # real R2 (env vars below)
python3 ingestion/run_ingestion.py --store r2 --activate <release_id>                                       # rollback
```
Useful flags: `--max-services N`, `--skip-pdfs`, `--no-ocr`, `--delay S`, `--embeddings`, `--pre-publish-check "<cmd>"`, `--cache-dir`, `--release-id`.
Exit codes: 0 ok · 2 ingestion aborted · 3 validation/pre-publish check failed · 4 publish failed.
R2 environment: `CLOUDFLARE_ACCOUNT_ID`, `R2_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (bucket-scoped R2 S3 token); embeddings add `CLOUDFLARE_AI_TOKEN`.

## Outputs
`build/release/` (see ARCHITECTURE.md for the layout) with `reports/extraction-report.json` (totals, failures, per-service warnings, PDFs incl. OCR pages, duplicates, removed sources, unavailable-field counts) and `reports/validation-report.json`.
