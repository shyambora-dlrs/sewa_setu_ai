/** POST /api/v1/chat - grounded RAG answer. Conversations are never persisted. */
import { Hono } from "hono";
import { chatRequestSchema } from "../../packages/application/dto";
import { parseWith, readJson } from "../http";
import type { HonoEnv } from "../types";

export const chatRoutes = new Hono<HonoEnv>();

chatRoutes.post("/chat", async (c) => {
  const body = parseWith(chatRequestSchema, await readJson(c));
  // Privacy: the question text is deliberately not logged.
  const answer = await c.var.services.app.rag.answer(body);
  c.header("cache-control", "no-store");
  return c.json(answer);
});
