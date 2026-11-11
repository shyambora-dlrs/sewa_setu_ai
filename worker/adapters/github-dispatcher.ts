/**
 * Triggers the ingestion GitHub Actions workflow via workflow_dispatch.
 *
 * The Worker never crawls or extracts PDFs itself (CPU limits); "Rebuild index"
 * in the admin panel simply asks GitHub to run the Python pipeline.
 */
import { AppError, NotConfiguredError } from "../../packages/domain/errors";

export interface DispatchConfig {
  repo: string;
  workflow: string;
  token: string | undefined;
  ref?: string;
  fetchImpl?: typeof fetch;
}

export async function dispatchIngestion(cfg: DispatchConfig): Promise<{ dispatched: true; workflow: string }> {
  if (!cfg.token || !cfg.repo || cfg.repo.startsWith("REPLACE_")) {
    throw new NotConfiguredError("Rebuild is not configured: set GITHUB_REPO and the GITHUB_DISPATCH_TOKEN secret.");
  }
  const f = cfg.fetchImpl ?? fetch;
  const res = await f(`https://api.github.com/repos/${cfg.repo}/actions/workflows/${cfg.workflow}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "sewasetu-ai-worker",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: cfg.ref ?? "main", inputs: { reason: "admin-panel" } }),
  });
  if (res.status !== 204) throw new AppError("upstream_error", `GitHub rejected the dispatch request (HTTP ${res.status}).`);
  return { dispatched: true, workflow: cfg.workflow };
}
