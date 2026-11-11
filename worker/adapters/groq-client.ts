/**
 * Groq chat-completions adapter implementing the LlmProvider port.
 *
 * Endpoint: https://api.groq.com/openai/v1/chat/completions (OpenAI-compatible).
 * The API key is a Worker secret and never leaves the server.
 *
 * Reliability policy
 *  - Per-attempt timeout via AbortController (default 20 s).
 *  - Up to `maxRetries` retries for transient failures: network errors,
 *    timeouts, HTTP 408/429/5xx - with exponential backoff + jitter. A
 *    `Retry-After` longer than `maxRetryAfterMs` is not waited out: we surface a
 *    rate-limit error instead of stalling the citizen's request.
 *  - Non-transient 4xx (bad request, auth) are not retried.
 *  - Chat completions are idempotent reads from our point of view, but retries
 *    are still bounded so cost and latency stay predictable.
 */
import { LlmError } from "../../packages/domain/errors";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../packages/domain/ports";

export interface GroqOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryAfterMs?: number;
  /** Injection points for tests. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_URL = "https://api.groq.com/openai/v1/chat/completions";

export class GroqClient implements LlmProvider {
  private readonly o: Required<Omit<GroqOptions, "apiKey" | "model">> & Pick<GroqOptions, "apiKey" | "model">;

  constructor(options: GroqOptions) {
    this.o = {
      baseUrl: DEFAULT_URL,
      timeoutMs: 20_000,
      maxRetries: 2,
      maxRetryAfterMs: 3_000,
      fetchImpl: (...a) => fetch(...a),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      ...options,
    };
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    let lastError: LlmError | null = null;
    for (let attempt = 0; attempt <= this.o.maxRetries; attempt++) {
      try {
        return await this.attempt(request);
      } catch (err) {
        if (!(err instanceof LlmError)) throw err;
        lastError = err;
        if (!err.retryable || attempt === this.o.maxRetries) break;
        // Honour Retry-After when reasonable, else exponential backoff with jitter.
        const waitMs =
          err.retryAfterSeconds !== undefined
            ? err.retryAfterSeconds * 1000
            : 300 * 2 ** attempt + Math.floor(this.o.random() * 200);
        if (waitMs > this.o.maxRetryAfterMs) break;
        await this.o.sleep(waitMs);
      }
    }
    throw lastError!;
  }

  /** One HTTP attempt: builds the request, enforces the timeout and normalises errors. */
  private async attempt(request: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), this.o.timeoutMs);
    // Respect a caller-supplied cancellation (e.g. the citizen disconnected).
    request.signal?.addEventListener("abort", () => controller.abort("cancelled"), { once: true });

    let res: Response;
    try {
      res = await this.o.fetchImpl(this.o.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model,
          messages: request.messages,
          max_completion_tokens: request.maxTokens,
          // gpt-oss models spend completion tokens on hidden reasoning; keep it low so the answer fits the budget.
          ...(this.o.model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
          temperature: request.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.reason === "timeout") throw new LlmError("upstream_timeout", "The language model timed out.", true);
      if (controller.signal.reason === "cancelled") throw new LlmError("upstream_error", "Request cancelled.", false);
      throw new LlmError("upstream_error", `Could not reach the language model: ${(err as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new LlmError("upstream_rate_limited", "The language model is rate limited.", true, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
    }
    if (res.status === 408 || res.status >= 500) throw new LlmError("upstream_error", `Language model error (HTTP ${res.status}).`, true);
    if (!res.ok) {
      // Do not echo the upstream body: it may contain request details.
      throw new LlmError("upstream_error", `Language model rejected the request (HTTP ${res.status}).`, false);
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new LlmError("upstream_error", "Language model returned malformed JSON.", true);
    }
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new LlmError("upstream_error", "Language model response had no message content.", false);
    return {
      text,
      model: typeof body.model === "string" ? body.model : this.o.model,
      usage: { promptTokens: body.usage?.prompt_tokens, completionTokens: body.usage?.completion_tokens },
    };
  }
}
