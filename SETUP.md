# Local setup

Requirements: **Node.js ≥ 22.12** (Wrangler 4 / Vite 8), **Python ≥ 3.12**, Tesseract (optional, only for scanned-PDF OCR and its test).
No Cloudflare account is needed for local development: `vite dev` runs the Worker in the local workerd runtime with an emulated R2 bucket.

```bash
git clone <repo> && cd sewasetu-ai
npm ci
python3 -m pip install -r ingestion/requirements.txt      # use a virtualenv if your OS requires it (PEP 668)
sudo apt-get install tesseract-ocr tesseract-ocr-eng       # optional (macOS: brew install tesseract)
cp .dev.vars.example .dev.vars                             # then edit: GROQ_API_KEY=…, ADMIN_API_TOKEN=<long random string>
```

## 1. Get a knowledge release locally
Ingestion crawls the live portal politely (1 request/second, ≈ 15 minutes for the full directory and PDFs). First set your contact address in `ingestion/config/sources.yaml` (`user_agent`).
```bash
npm run ingest -- --max-services 25            # quick trial run (omit the flag for everything)
npx tsx scripts/validate-release.ts build/release   # prove the Worker's schemas can read it
npm run seed:local                              # loads build/release into the LOCAL R2 emulation (.wrangler/state)
```
All records start as `draft`. For local development set `SERVE_UNREVIEWED_CONTENT` to `"true"` (edit `vars` in `wrangler.jsonc` or use the staging env) so the citizen UI shows them, **or** approve services in the admin panel.

## 2. Run
```bash
npm run dev          # http://localhost:5173  (SPA + Worker + /api/v1 + /mcp together)
```
* Citizen app: `/` · Admin: `/admin` (paste the `ADMIN_API_TOKEN` from `.dev.vars`).
* Check it: `npx tsx scripts/local-smoke-test.ts http://localhost:5173` (add `--chat` once `GROQ_API_KEY` is set).
* MCP: `npx @modelcontextprotocol/inspector` → Streamable HTTP → `http://localhost:5173/mcp`.

## 3. Tests and checks
```bash
npm run check        # typecheck + vitest + pytest + production build
```

## Groq configuration
1. Create a key at <https://console.groq.com/keys>.
2. Local: put it in `.dev.vars` as `GROQ_API_KEY`. Production: `npx wrangler secret put GROQ_API_KEY`.
3. Model: `GROQ_MODEL` in `wrangler.jsonc` (default `openai/gpt-oss-120b`). Model access differs per account: list yours with `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"` (`llama-3.3-70b-versatile` was not available to the project owner's key). gpt-oss models are called with `reasoning_effort: low` so hidden reasoning does not consume the answer's token budget.
Without a key the chat endpoint degrades to returning retrieved passages (`degraded: true`) and everything else works.

## Administrator setup
* Local/CI: set `ADMIN_API_TOKEN`. Production (recommended): put the Worker behind **Cloudflare Access** and set `CF_ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`), `CF_ACCESS_AUD` (the Access application AUD tag) and `ADMIN_EMAILS` (comma-separated allow-list) in `wrangler.jsonc` vars. Details in DEPLOYMENT.md.
* "Rebuild" in the admin panel needs `GITHUB_REPO` (var) and the `GITHUB_DISPATCH_TOKEN` secret (fine-grained PAT, repository permission *Actions: Read and write*).

## Troubleshooting
* `503 knowledge_unavailable` — no release in R2 yet: run ingestion + `npm run seed:local`.
* Empty catalogue in production mode — nothing has been approved; approve in `/admin` or enable `SERVE_UNREVIEWED_CONTENT` (staging default).
* `pip` refuses to install (PEP 668) — use `python3 -m venv .venv && . .venv/bin/activate` (needs `python3-venv`).
