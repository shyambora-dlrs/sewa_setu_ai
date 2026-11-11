/** Small HTTP helpers shared by route modules: validated parsing and the error envelope. */
import type { Context } from "hono";
import { z, ZodError } from "zod";
import { AppError, ValidationError, httpStatusFor } from "../packages/domain/errors";
import { LIMITS } from "../packages/shared/constants";
import type { HonoEnv } from "./types";

/** Validates a plain object (query params) with a Zod schema, mapping failures to a 400. */
export function parseWith<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw zodToValidation(result.error);
  return result.data;
}

export function zodToValidation(err: ZodError): ValidationError {
  return new ValidationError("Request validation failed.", {
    issues: err.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

/**
 * Reads a JSON body with a hard byte cap. The cap is enforced on the actual bytes
 * read (Content-Length can be absent or lie), preventing oversized payloads.
 */
export async function readJson(c: Context<HonoEnv>, maxBytes: number = LIMITS.requestBodyBytes): Promise<unknown> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > maxBytes) throw new AppError("payload_too_large", "Request body is too large.");
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ValidationError("A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError("payload_too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  // Concatenate the (already size-capped) chunks before decoding as UTF-8.
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
}

/** Consistent JSON error envelope: { error: { code, message, details?, request_id } }. */
export function errorResponse(c: Context<HonoEnv>, err: unknown): Response {
  const requestId = c.get("requestId");
  if (err instanceof ZodError) err = zodToValidation(err);
  if (err instanceof AppError) {
    const status = httpStatusFor(err.code);
    if (err.details?.retry_after_seconds) c.header("retry-after", String(err.details.retry_after_seconds));
    return c.json({ error: { code: err.code, message: err.message, details: err.details, request_id: requestId } }, status as 400);
  }
  // Unknown failure: log with the request id but return a generic message (no stack/secret leakage).
  console.error(JSON.stringify({ level: "error", request_id: requestId, name: (err as Error)?.name, message: (err as Error)?.message }));
  return c.json({ error: { code: "internal_error", message: "An unexpected error occurred.", request_id: requestId } }, 500);
}
