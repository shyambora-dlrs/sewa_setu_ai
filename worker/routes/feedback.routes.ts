/** POST /api/v1/feedback - lets citizens flag incorrect or outdated information. */
import { Hono } from "hono";
import { z } from "zod";
import { serviceIdSchema } from "../../packages/application/dto";
import { guardQuestion } from "../../packages/application/guards";
import { parseWith, readJson } from "../http";
import type { HonoEnv } from "../types";

export const feedbackRoutes = new Hono<HonoEnv>();

const body = z.object({
  service_id: serviceIdSchema.optional(),
  type: z.enum(["incorrect", "outdated", "missing", "other"]),
  message: z.string().trim().max(500).optional(),
});

feedbackRoutes.post("/feedback", async (c) => {
  const input = parseWith(body, await readJson(c, 4096));
  // Privacy: strip anything that looks like an Aadhaar/phone/OTP before it is stored.
  const message = input.message ? guardQuestion(input.message).sanitized : null;
  await c.var.services.admin.putFeedback({ service_id: input.service_id ?? null, type: input.type, message });
  return c.json({ received: true }, 201);
});
