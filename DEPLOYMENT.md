# Deployment

Nothing in this repository has been deployed to Cloudflare by the author: no account credentials were available. The configuration
below was validated with `wrangler deploy --dry-run` (bundling and binding checks) and `vite build`.

Topology: one Worker (`sewasetu-ai`) serves the React SPA as static assets, `/api/v1/*`, `/mcp` and `/health`; one private R2 bucket
(`sewasetu-knowledge`) holds all content; GitHub Actions publishes knowledge releases. Environments: **production** (top-level
`wrangler.jsonc`) and **staging** (`env.staging`: Worker `sewasetu-ai-staging`, bucket `sewasetu-knowledge-staging`, unreviewed content visible).

## 1. One-time Cloudflare setup
```bash
npm ci && npx wrangler login && npx wrangler whoami
npx wrangler r2 bucket create sewasetu-knowledge            # production, PRIVATE (never enable public access / r2.dev)
npx wrangler r2 bucket create sewasetu-knowledge-staging
npx wrangler r2 bucket list
```
If a bucket exists already, reuse it. Do **not** create D1/KV/Durable Objects/Vectorize.

### R2 API token for ingestion (GitHub Actions)
Dashboard → R2 → *Manage R2 API Tokens* → create a token with **Object Read & Write** limited to the bucket(s). Keep the Access Key ID and Secret.
### Worker deploy token
Dashboard → My Profile → API Tokens → custom token with **Account › Workers Scripts › Edit** (and nothing else). Different from the R2 token.

## 2. Secrets
```bash
npx wrangler secret put GROQ_API_KEY                 # production
npx wrangler secret put ADMIN_API_TOKEN              # fallback admin auth (skip if only Cloudflare Access is used)
npx wrangler secret put GITHUB_DISPATCH_TOKEN        # optional: admin "Rebuild"
# staging: add  --env staging  to each command
```
GitHub repository (or environment) secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DEPLOY_API_TOKEN` (deploy), `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (ingestion), optional `CLOUDFLARE_AI_TOKEN` (embeddings only). Repository variable `ENABLE_EMBEDDINGS=true` enables embedding generation. Never put secrets in `vars` or commit `.dev.vars`.

## 3. Configure
Edit `wrangler.jsonc`: `GITHUB_REPO` (`owner/repo`), `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `ADMIN_EMAILS`, confirm `GROQ_MODEL`. Set your contact address in `ingestion/config/sources.yaml`.
Regenerate types after changing bindings: `npm run cf-typegen`.

## 4. Publish the first knowledge release (before or after deploying the Worker)
Via GitHub: Actions → *Ingest and publish Sewa Setu knowledge* → Run workflow. Or locally:
```bash
export CLOUDFLARE_ACCOUNT_ID=… R2_BUCKET_NAME=sewasetu-knowledge AWS_ACCESS_KEY_ID=<R2 key id> AWS_SECRET_ACCESS_KEY=<R2 secret>
python3 ingestion/run_ingestion.py --output build/release --validate --publish --store r2 \
        --pre-publish-check "npx tsx scripts/validate-release.ts build/release"
```
Review `build/release/reports/extraction-report.json`. All records are `draft`: approve the ones you have checked in `/admin` (production hides drafts).

## 5. Deploy the Worker
```bash
npm run check                      # typecheck, tests, build
npm run deploy                     # production:  vite build && wrangler deploy -c apps/web/dist/sewasetu_ai/wrangler.json
npm run deploy:staging             # staging
```
The Cloudflare Vite plugin writes the deployable config to `apps/web/dist/sewasetu_ai/wrangler.json`; the `CLOUDFLARE_ENV` used at build time selects the environment, which is why staging has its own build command.

## 6. Verify (spec step 8)
```bash
npx tsx scripts/local-smoke-test.ts https://sewasetu-ai.<subdomain>.workers.dev --chat
npx @modelcontextprotocol/inspector   # Streamable HTTP → https://…/mcp
curl -I https://<r2-bucket-public-url>/current.json    # must NOT work: bucket stays private
```
Also check `/` (SPA), `/health`, `/api/v1/catalog`, `/api/v1/search?q=land`, `/api/v1/chat`, unknown service → structured 404, `/admin` requires login.

## 7. Cloudflare Access for `/admin` (recommended)
Zero Trust → Access → Applications → *Self-hosted*, destinations `<host>/admin*` and `<host>/api/v1/admin*`, allow only your administrators. Copy the **Application Audience (AUD) tag** and your team domain into `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN`, list admin emails in `ADMIN_EMAILS`, redeploy. The Worker validates the Access JWT itself. Do not put Access on `/`, `/api/v1/*` (public) or `/mcp`.

## 8. Custom domain (optional, after verification)
Workers & Pages → `sewasetu-ai` → Settings → Domains & Routes → Add custom domain (DNS must be on Cloudflare). Re-run the smoke test. For MCP on custom domains set `allowedHostnames` if you want Host pinning (`worker/mcp/create-server.ts`).

## 9. Scheduled ingestion
The workflow runs daily at 22:00 UTC (≈ 03:30 IST) and on demand. Enable the schedule only after one manual run succeeded. `/health` reports `knowledge.stale` after `KNOWLEDGE_STALE_AFTER_HOURS` (72 production); the Worker's daily cron (`30 22 * * *`) writes a structured freshness log line (visible in Workers Logs — set up an alert on `"stale":true` or `knowledge_unavailable`).

## 10. CI/CD
`deploy-worker.yml`: PRs run schema-drift check, typecheck, Vitest, pytest and build (no deploy, no secrets). Push to `main` runs the same checks and deploys production (GitHub environment `production` can require approval). Manual dispatch deploys staging or production. `rollback-release.yml` rolls the knowledge pointer back. Pin actions to commit SHAs if your policy requires it (currently pinned to major versions).

## Rollback
* **Knowledge** (instant, no data copied): admin panel → Ingestion → *Activate this release*, or run the *Roll back knowledge release* workflow, or
  `python3 ingestion/run_ingestion.py --store r2 --activate <release_id>`. The newest 4 releases are retained; the Worker sees the change within 30 s.
* **Worker code**: `npx wrangler rollback` (or Dashboard → Deployments → rollback), or redeploy the previous commit.
* Review decisions are independent of releases (stored under `admin/`), so a knowledge rollback does not lose them.

## Costs / limits to check
Workers plan CPU limits (index shards are small and cached per isolate; benchmark with the real corpus), R2 storage/operations (raw snapshots grow with every changed page — add a lifecycle rule for `sources/` if needed), Groq rate limits for your key, GitHub Actions minutes (a full crawl is ~15–20 min).
