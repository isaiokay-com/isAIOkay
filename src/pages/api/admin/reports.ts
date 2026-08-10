import type { APIRoute } from "astro";
import { listAdminReports, setReportModeration } from "../../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireAdministrator } from "../../../services/auth";
import { z } from "zod";

export const prerender = false;

const updateSchema = z.object({ reportId: z.uuid(), status: z.enum(["pending", "approved", "excluded"]) }).strict();

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    await requireAdministrator(context.request, env);
    const status = new URL(context.request.url).searchParams.get("status") ?? undefined;
    return json(await listAdminReports(env, status));
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const PATCH: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireAdministrator(context.request, env);
    const update = updateSchema.parse(await context.request.json());
    await setReportModeration({ env, reportId: update.reportId, status: update.status, actorUserId: identity.userId });
    return json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
};
