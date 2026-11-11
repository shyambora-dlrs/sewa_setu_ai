/**
 * Production composition root: wires R2, Groq and (optionally) Workers AI adapters
 * into the application container. This is the only place that knows concrete
 * infrastructure classes (Dependency Inversion).
 */
import { createApplication } from "../packages/application/container";
import { ReviewOverlayRepository } from "../packages/application/review-overlay-repository";
import { LlmError, NotConfiguredError } from "../packages/domain/errors";
import type { LlmProvider } from "../packages/domain/ports";
import { dispatchIngestion } from "./adapters/github-dispatcher";
import { GroqClient } from "./adapters/groq-client";
import { R2AdminStore } from "./adapters/r2-admin-store";
import { R2KnowledgeRepository } from "./adapters/r2-knowledge-repository";
import { R2ReleaseAdmin } from "./adapters/r2-release-admin";
import { WorkersAiEmbeddings } from "./adapters/workers-ai-embeddings";
import type { AppEnv } from "./env";
import { authenticateAdmin } from "./middleware/access-auth";
import type { Services } from "./types";

/**
 * Module-level instances survive across requests within an isolate, which is what
 * makes the R2 repository's release-keyed caches effective.
 */
let cached: { bucket: R2Bucket; repo: R2KnowledgeRepository; admin: R2AdminStore } | null = null;

/** Fails every call clearly when GROQ_API_KEY is missing instead of crashing at startup. */
class UnconfiguredLlm implements LlmProvider {
  async complete(): Promise<never> {
    throw new LlmError("upstream_error", "The language model is not configured (missing GROQ_API_KEY).", false);
  }
}

export function buildServices(env: AppEnv): Services {
  if (!cached || cached.bucket !== env.KNOWLEDGE_BUCKET) {
    const repo = new R2KnowledgeRepository(env.KNOWLEDGE_BUCKET);
    cached = { bucket: env.KNOWLEDGE_BUCKET, repo, admin: new R2AdminStore(env.KNOWLEDGE_BUCKET) };
  }
  const { repo, admin } = cached;

  const llm: LlmProvider = env.GROQ_API_KEY ? new GroqClient({ apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL }) : new UnconfiguredLlm();
  const semantic = env.SEMANTIC_SEARCH_ENABLED === "true";
  if (semantic && !env.AI) throw new NotConfiguredError("SEMANTIC_SEARCH_ENABLED is true but the AI binding is missing in wrangler.jsonc.");

  const app = createApplication({
    repo: new ReviewOverlayRepository(repo, admin),
    index: repo,
    llm,
    embedder: semantic && env.AI ? new WorkersAiEmbeddings(env.AI, env.EMBEDDING_MODEL) : null,
    allowDraft: env.SERVE_UNREVIEWED_CONTENT === "true",
    rag: {
      maxChunks: Math.min(12, Math.max(1, Number(env.MAX_RETRIEVAL_CHUNKS) || 8)),
      queryRewrite: env.QUERY_REWRITE_ENABLED !== "false",
    },
  });

  return {
    app,
    admin,
    releases: new R2ReleaseAdmin(env.KNOWLEDGE_BUCKET),
    authenticate: (req) => authenticateAdmin(req, env),
    dispatchRebuild: () =>
      dispatchIngestion({ repo: env.GITHUB_REPO, workflow: env.GITHUB_INGEST_WORKFLOW, token: env.GITHUB_DISPATCH_TOKEN }),
    staleAfterHours: Number(env.KNOWLEDGE_STALE_AFTER_HOURS) || 72,
    now: () => new Date(),
  };
}
