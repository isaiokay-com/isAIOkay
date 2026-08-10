import type { APIRoute } from "astro";
import { z } from "zod";
import { dismissCatalogCandidate, listCatalogCandidates, promoteCatalogCandidate } from "../../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { httpsUrlSchema } from "../../../lib/security";
import { requireAdministrator } from "../../../services/auth";

export const prerender = false;

const actionSchema = z.object({
  action: z.enum(["promote", "dismiss"]),
  candidateId: z.uuid(),
  officialUrl: httpsUrlSchema.optional(),
  name: z.string().trim().min(1).max(80).optional(),
  providerName: z.string().trim().min(1).max(80).optional(),
  type: z.enum(["model", "agent"]).optional(),
  description: z.string().trim().max(500).optional(),
  versionLabel: z.string().trim().max(80).nullable().optional(),
  releaseAt: z.number().int().positive().nullable().optional(),
  releaseSourceUrl: httpsUrlSchema.nullable().optional()
}).strict().superRefine((value, context) => {
  if (value.action !== "promote") return;
  if (!value.officialUrl) {
    context.addIssue({ code: "custom", path: ["officialUrl"], message: "An official product URL is required to promote a candidate." });
  }
  if ((value.releaseAt === null || value.releaseAt === undefined) !== (value.releaseSourceUrl === null || value.releaseSourceUrl === undefined)) {
    context.addIssue({ code: "custom", message: "Release date and official release source must be provided together." });
  }
});

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    await requireAdministrator(context.request, env);
    const statusParam = new URL(context.request.url).searchParams.get("status");
    const status = statusParam === "pending" || statusParam === "promoted" || statusParam === "dismissed" ? statusParam : undefined;
    return json({ candidates: await listCatalogCandidates(env, status) });
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireAdministrator(context.request, env);
    const input = actionSchema.parse(await context.request.json());
    if (input.action === "dismiss") {
      await dismissCatalogCandidate({ env, candidateId: input.candidateId, actorUserId: identity.userId });
      return json({ ok: true, action: "dismissed" });
    }
    const promoted = await promoteCatalogCandidate({
      env,
      candidateId: input.candidateId,
      actorUserId: identity.userId,
      overrides: {
        officialUrl: input.officialUrl ?? "",
        name: input.name,
        providerName: input.providerName,
        type: input.type,
        description: input.description,
        versionLabel: input.versionLabel,
        releaseAt: input.releaseAt,
        releaseSourceUrl: input.releaseSourceUrl
      }
    });
    return json({ ok: true, action: "promoted", ...promoted });
  } catch (error) {
    return toErrorResponse(error);
  }
};
