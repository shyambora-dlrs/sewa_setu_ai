/**
 * Composition of application services from ports (manual dependency injection).
 * The Worker builds one container per request from its adapters; tests build
 * containers from in-memory fakes. Nothing here knows about Cloudflare or Groq.
 */
import type { EmbeddingProvider, IndexStore, KnowledgeRepository, LlmProvider } from "../domain/ports";
import { HybridRetriever } from "../retrieval/hybrid-retriever";
import { CatalogService, type VisibilityPolicy } from "./catalog-service";
import { FactsService } from "./facts-service";
import { DEFAULT_RAG_CONFIG, RagService, type RagConfig } from "./rag-service";
import { SearchService } from "./search-service";

export interface ContainerDeps {
  /** Repository that already includes the review overlay. */
  repo: KnowledgeRepository;
  index: IndexStore;
  llm: LlmProvider;
  embedder?: EmbeddingProvider | null;
  /** Citizen visibility: true to include unreviewed (draft) records. */
  allowDraft: boolean;
  rag?: Partial<RagConfig>;
}

export function createApplication(deps: ContainerDeps) {
  const citizenVisible: VisibilityPolicy = (s) => s === "verified" || (s === "draft" && deps.allowDraft);
  const adminVisible: VisibilityPolicy = () => true;
  const retriever = new HybridRetriever(deps.repo, deps.index, deps.embedder ?? null);
  const catalog = new CatalogService(deps.repo, citizenVisible);
  const search = new SearchService(deps.repo, retriever, citizenVisible);
  const facts = new FactsService(catalog, deps.repo);
  const rag = new RagService(deps.repo, search, retriever, deps.llm, citizenVisible, { ...DEFAULT_RAG_CONFIG, ...deps.rag });
  const adminCatalog = new CatalogService(deps.repo, adminVisible);
  return { catalog, search, facts, rag, adminCatalog, repo: deps.repo };
}
export type Application = ReturnType<typeof createApplication>;
