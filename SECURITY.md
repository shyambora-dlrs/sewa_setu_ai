# Security and privacy

What is **implemented** (with where to find it) and what remains an operational responsibility.

## Secrets
* `GROQ_API_KEY`, `ADMIN_API_TOKEN`, `GITHUB_DISPATCH_TOKEN` are Worker **secrets** (`wrangler secret put`) or `.dev.vars` locally (git-ignored; `.dev.vars.example` has placeholders only). They are not in `vars`, the React bundle or logs.
* The browser only calls the Worker; there is no third-party key in the frontend (a test asserts the chat request carries no authorization header).
* CI: R2 publishing credentials (bucket-scoped S3 token) and the Worker deploy token are **separate** secrets; the ingestion job never receives a Groq key.

## Public API hardening
* Zod validation on every query/body/MCP input; bounded page sizes, question length (1000), history (6 turns × 1200 chars), body size (64 KB, enforced on bytes actually read), uploads (20 MB).
* Per-client rate limits (chat 20/min, read 120/min, MCP 60/min, admin 120/min, feedback 10/min) — `worker/middleware/rate-limit.ts`. **Limitation:** counters are per isolate; configure a Cloudflare WAF rate-limiting rule for global enforcement.
* Consistent error envelope; unexpected errors are logged with a request id and returned generically (no stack traces, no upstream bodies).
* Response headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; static assets get a strict CSP via `apps/web/public/_headers`.
* Service ids are validated against `^[a-z0-9-]+$` before being embedded in an R2 key (no path traversal); clients never supply R2 keys. The bucket is private and only reachable through the Worker binding.

## Administrator access
* Fails closed: if neither Cloudflare Access nor `ADMIN_API_TOKEN` is configured every admin route returns 503.
* **Cloudflare Access** (recommended): the Worker itself verifies the `Cf-Access-Jwt-Assertion` RS256 JWT against the team JWKS — signature, `exp`/`nbf`, issuer, audience, email, and the optional `ADMIN_EMAILS` allow-list. `alg: none`/HS256 downgrades are rejected. (An Access policy alone is not trusted because the `workers.dev` hostname can be reached directly.)
* **Bearer token** fallback, compared in constant time. Local dev and CI only; rotate if exposed.
* Hiding admin links protects nothing; every route authenticates (`tests/auth.test.ts` checks anonymous access is rejected everywhere).
* Review decisions record the reviewer identity and timestamp. Approvals are bound to the content hash and go stale when the official page changes.
* Uploads: `%PDF-` magic bytes (not the client content-type), size limit, content-addressed storage; PDFs are only ever parsed by the ingestion job, never served back.

## LLM safety
* Retrieved text is **untrusted data**: control characters removed, `<`/`>` neutralised so it cannot close the `<source>` delimiters, and the system prompt states that source content is never instructions (test: prompt-injection fixture).
* If no evidence is retrieved the model is not called (fixed localized "cannot verify" answer).
* Citations are validated; unknown `[S#]` tags are stripped. Answers are labelled confirmed / unverified / unavailable.
* Aadhaar-like numbers, long digit runs and "OTP/PIN/password …" phrases are removed from the question **before** it reaches Groq; a message that is only secrets is refused. The assistant never asks for credentials and refers application-status questions to the official Track option.
* Timeouts (20 s per attempt), bounded retries (2) with backoff and Retry-After handling, bounded output tokens (700) and context size (9000 chars).

## Privacy
* Conversations are not stored. Question text is not logged. Feedback is stored without identity (type, optional ≤500-char message with digit runs stripped).
* The ingestion crawler touches only public service pages and PDFs; it never logs in, solves CAPTCHAs or reads application data.

## Crawler ethics
Allow-listed hosts only (redirects re-checked), robots.txt honoured (RFC 9309 semantics), 1 req/s per host, descriptive User-Agent (set your contact address in `ingestion/config/sources.yaml`), conditional requests, retry/backoff limits, size limits. 401/403/CAPTCHA pages are reported as failures and never bypassed.

## Known gaps / operator responsibilities
* Global rate limiting and bot protection (WAF/Turnstile) are not configured by this repo.
* Cloudflare Access must be set up by the operator; without it only the bearer token protects the admin API.
* Hindi/Assamese UI strings and the cross-lingual lexicon are machine-assisted drafts and need native-speaker review.
* No automated dependency-vulnerability scanning is configured (`npm audit` reported 0 vulnerabilities at install time).
* MCP is public read-only. Any future private-data tool needs OAuth with per-tool authorization before being added.
