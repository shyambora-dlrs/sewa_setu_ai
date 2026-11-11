/**
 * Worker environment contract.
 *
 * `wrangler types` generates literal types for `vars` (e.g. GROQ_MODEL: "llama-..."),
 * which are too narrow to be useful in code, so we declare the runtime shape
 * explicitly here. Bindings/vars come from wrangler.jsonc; secrets are set with
 * `wrangler secret put` (production) or `.dev.vars` (local) and are NEVER in vars.
 */
export interface AppEnv {
  /* ---- bindings ---- */
  /** Private R2 bucket holding releases (read) and admin state (read/write). */
  KNOWLEDGE_BUCKET: R2Bucket;
  /** Workers AI binding - only present once semantic search is enabled in wrangler.jsonc. */
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  /** Static asset fetcher added by the Workers Assets runtime. */
  ASSETS?: Fetcher;

  /* ---- plain-text vars ---- */
  APP_ENV: string;
  GROQ_MODEL: string;
  SERVE_UNREVIEWED_CONTENT: string;
  SEMANTIC_SEARCH_ENABLED: string;
  EMBEDDING_MODEL: string;
  MAX_RETRIEVAL_CHUNKS: string;
  QUERY_REWRITE_ENABLED: string;
  KNOWLEDGE_STALE_AFTER_HOURS: string;
  GITHUB_REPO: string;
  GITHUB_INGEST_WORKFLOW: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  ADMIN_EMAILS: string;

  /* ---- secrets ---- */
  GROQ_API_KEY?: string;
  ADMIN_API_TOKEN?: string;
  GITHUB_DISPATCH_TOKEN?: string;
}
