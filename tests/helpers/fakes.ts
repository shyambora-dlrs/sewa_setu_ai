import type { LlmProvider, LlmRequest, LlmResponse } from "../../packages/domain/ports";
import { createApplication } from "../../packages/application/container";
import { ReviewOverlayRepository } from "../../packages/application/review-overlay-repository";
import { R2AdminStore } from "../../worker/adapters/r2-admin-store";
import { R2KnowledgeRepository } from "../../worker/adapters/r2-knowledge-repository";
import { R2ReleaseAdmin } from "../../worker/adapters/r2-release-admin";
import type { Services } from "../../worker/types";
import { authenticateAdmin } from "../../worker/middleware/access-auth";
import type { AppEnv } from "../../worker/env";
import { FakeR2Bucket } from "./fake-r2";

/** Scripted LLM: returns queued replies (or a function result) and records every request. */
export class FakeLlm implements LlmProvider {
  readonly calls: LlmRequest[] = [];
  constructor(private reply: string | ((req: LlmRequest, n: number) => string | Error) = "OK") {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const r = typeof this.reply === "function" ? this.reply(req, this.calls.length) : this.reply;
    if (r instanceof Error) throw r;
    return { text: r, model: "fake-model" };
  }
}

export interface TestWorld {
  bucket: FakeR2Bucket;
  llm: FakeLlm;
  env: AppEnv;
  services: Services;
  repo: R2KnowledgeRepository;
}

/** Builds production-shaped services over fakes (R2 + LLM). */
export function buildWorld(opts: { llm?: FakeLlm; allowDraft?: boolean; env?: Partial<AppEnv>; bucket?: FakeR2Bucket } = {}): TestWorld {
  const bucket = opts.bucket ?? new FakeR2Bucket();
  const llm = opts.llm ?? new FakeLlm();
  const env: AppEnv = {
    KNOWLEDGE_BUCKET: bucket.asBucket(), APP_ENV: "test", GROQ_MODEL: "fake", SERVE_UNREVIEWED_CONTENT: String(opts.allowDraft ?? true),
    SEMANTIC_SEARCH_ENABLED: "false", EMBEDDING_MODEL: "@cf/baai/bge-m3", MAX_RETRIEVAL_CHUNKS: "8", QUERY_REWRITE_ENABLED: "false",
    KNOWLEDGE_STALE_AFTER_HOURS: "72", GITHUB_REPO: "o/r", GITHUB_INGEST_WORKFLOW: "w.yml", CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "",
    ADMIN_EMAILS: "", ADMIN_API_TOKEN: "test-admin-token-123", ...opts.env,
  };
  const repo = new R2KnowledgeRepository(bucket.asBucket(), { pointerTtlMs: 0, maxCacheEntries: 64 });
  const admin = new R2AdminStore(bucket.asBucket(), () => new Date("2026-11-12T00:00:00Z"), 0);
  const app = createApplication({
    repo: new ReviewOverlayRepository(repo, admin), index: repo, llm, embedder: null, allowDraft: env.SERVE_UNREVIEWED_CONTENT === "true",
    rag: { queryRewrite: false },
  });
  const services: Services = {
    app, admin, releases: new R2ReleaseAdmin(bucket.asBucket(), () => new Date("2026-11-12T00:00:00Z")),
    authenticate: (req) => authenticateAdmin(req, env),
    dispatchRebuild: async () => ({ dispatched: true, workflow: "w.yml" }),
    staleAfterHours: 72, now: () => new Date("2026-11-12T00:00:00Z"),
  };
  return { bucket, llm, env, services, repo };
}
