import type { APIRoute } from "astro";
import { z } from "zod";
import { upsertTrackedItem } from "../../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { httpsUrlSchema } from "../../../lib/security";
import { requireAdministrator } from "../../../services/auth";

export const prerender = false;

const itemSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(80),
  slug: z.string().regex(/^[a-z0-9-]+$/).max(80),
  providerName: z.string().trim().min(1).max(80),
  type: z.enum(["model", "agent"]),
  description: z.string().max(500).optional(),
  officialUrl: httpsUrlSchema,
  pricingSummary: z.string().max(500).optional(),
  versionLabel: z.string().max(80).nullable().optional(),
  releaseAt: z.number().int().positive().nullable().optional(),
  releaseSourceUrl: httpsUrlSchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional()
}).strict().superRefine((item, context) => {
  if ((item.releaseAt === null || item.releaseAt === undefined) !== (item.releaseSourceUrl === null || item.releaseSourceUrl === undefined)) {
    context.addIssue({ code: "custom", message: "Release date and source URL must be provided together." });
  }
});

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireAdministrator(context.request, env);
    const item = itemSchema.parse(await context.request.json());
    await upsertTrackedItem(env, item, identity.userId);
    return json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
};
