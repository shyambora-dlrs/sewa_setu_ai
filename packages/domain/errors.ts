/**
 * Domain error hierarchy. Application services throw these; the HTTP layer maps
 * them to the JSON error envelope and MCP tools map them to `isError` results,
 * so neither transport needs to know about the other's conventions.
 */
export type ErrorCode =
  | "validation_error"
  | "not_found"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "payload_too_large"
  | "knowledge_unavailable"
  | "upstream_timeout"
  | "upstream_rate_limited"
  | "upstream_error"
  | "not_configured"
  | "internal_error";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** Extra non-sensitive context returned to the client. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("validation_error", message, details);
  }
}
export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("not_found", message, details);
  }
}
/** The active knowledge release is missing or unreadable (e.g. before first ingestion). */
export class KnowledgeUnavailableError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("knowledge_unavailable", message, details);
  }
}
export class NotConfiguredError extends AppError {
  constructor(message: string) {
    super("not_configured", message);
  }
}
/** Failures talking to the LLM provider; `retryable` guides the retry policy. */
export class LlmError extends AppError {
  constructor(
    code: "upstream_timeout" | "upstream_rate_limited" | "upstream_error",
    message: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(code, message);
  }
}

/** Maps an error code to the HTTP status used by the REST API. */
export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "validation_error": return 400;
    case "unauthorized": return 401;
    case "forbidden": return 403;
    case "not_found": return 404;
    case "payload_too_large": return 413;
    case "rate_limited":
    case "upstream_rate_limited": return 429;
    case "upstream_timeout": return 504;
    case "upstream_error": return 502;
    case "knowledge_unavailable":
    case "not_configured": return 503;
    default: return 500;
  }
}
