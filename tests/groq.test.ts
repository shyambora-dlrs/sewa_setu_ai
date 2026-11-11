import { describe, expect, it, vi } from "vitest";
import { GroqClient } from "../worker/adapters/groq-client";
import { LlmError } from "../packages/domain/errors";

const req = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50, temperature: 0 };
const okBody = { model: "m", choices: [{ message: { content: "hello" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } };
const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { status: 200, ...init });
const client = (fetchImpl: typeof fetch, extra = {}) =>
  new GroqClient({ apiKey: "k-secret", model: "test-model", fetchImpl, sleep: async () => {}, random: () => 0, ...extra });

describe("GroqClient (mocked HTTP)", () => {
  it("sends the bearer key, model and bounded tokens; parses the reply", async () => {
    const f = vi.fn(async () => json(okBody));
    const res = await client(f as never).complete(req);
    expect(res.text).toBe("hello");
    expect(res.usage?.completionTokens).toBe(2);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k-secret");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "test-model", max_completion_tokens: 50, temperature: 0, stream: false });
  });

  it("retries transient 5xx and then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(json(okBody));
    expect((await client(f as never).complete(req)).text).toBe("hello");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("honours a short Retry-After on 429 and gives up after maxRetries", async () => {
    const f = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "1" } }));
    await expect(client(f as never).complete(req)).rejects.toMatchObject({ code: "upstream_rate_limited" });
    expect(f).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("does not wait out a long Retry-After", async () => {
    const f = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "120" } }));
    await expect(client(f as never).complete(req)).rejects.toBeInstanceOf(LlmError);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-transient client errors", async () => {
    const f = vi.fn(async () => new Response("bad key details", { status: 401 }));
    const err = (await client(f as never).complete(req).catch((e) => e)) as LlmError;
    expect(err.code).toBe("upstream_error");
    expect(err.message).not.toContain("bad key details"); // upstream body is never echoed
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("times out slow requests", async () => {
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))));
    const err = (await client(f as never, { timeoutMs: 10, maxRetries: 0 }).complete(req).catch((e) => e)) as LlmError;
    expect(err.code).toBe("upstream_timeout");
  });

  it("rejects malformed JSON and missing content", async () => {
    await expect(client((async () => new Response("<html>", { status: 200 })) as never, { maxRetries: 0 }).complete(req)).rejects.toMatchObject({ code: "upstream_error" });
    await expect(client((async () => json({ choices: [] })) as never).complete(req)).rejects.toMatchObject({ code: "upstream_error" });
  });

  it("surfaces network failures as retryable upstream errors", async () => {
    const f = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(json(okBody));
    expect((await client(f as never).complete(req)).text).toBe("hello");
  });
});
