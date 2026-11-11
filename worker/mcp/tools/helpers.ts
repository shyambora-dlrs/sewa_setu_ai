/**
 * Shared helpers for MCP tools: result shaping and uniform error handling.
 * Tools return both human-readable text (JSON) and `structuredContent` so that
 * simple clients and schema-aware clients are both served.
 */
import { AppError } from "../../../packages/domain/errors";
import { ZodError } from "zod";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function ok(data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/**
 * Runs a tool body and converts domain errors into MCP tool errors
 * (`isError: true`) so a "service not found" is reported to the model as data,
 * not as a protocol failure. Unexpected errors are masked.
 */
export async function guarded(body: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (err) {
    if (err instanceof AppError) {
      const e = { error: { code: err.code, message: err.message, details: err.details } };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(e) }], structuredContent: e };
    }
    if (err instanceof ZodError) {
      const e = { error: { code: "validation_error", message: "Invalid tool input." } };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(e) }], structuredContent: e };
    }
    console.error(JSON.stringify({ level: "error", where: "mcp-tool", name: (err as Error)?.name }));
    const e = { error: { code: "internal_error", message: "Unexpected error." } };
    return { isError: true, content: [{ type: "text", text: JSON.stringify(e) }], structuredContent: e };
  }
}

/** Read-only annotations advertised for every tool: clients can auto-approve them safely. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
