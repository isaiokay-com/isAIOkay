import type { APIRoute } from "astro";
import { getFeedbackAllowance } from "../../db/repositories";
import { requireIdentity } from "../../services/auth";
import { enforceNamedRateLimit } from "../../lib/rate-limit";
import { getClientKey, json, toErrorResponse } from "../../lib/http";
import { getRuntimeEnv } from "../../lib/runtime";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireIdentity(context.request, env);
    return json(await getFeedbackAllowance(env, identity.userId));
  } catch (error) {
    return toErrorResponse(error);
  }
};
