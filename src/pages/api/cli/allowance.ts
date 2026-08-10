import type { APIRoute } from "astro";
import { getFeedbackAllowance } from "../../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireCliIdentity } from "../../../services/cli-auth";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", `cli:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "allowance:read");
    return json(await getFeedbackAllowance(env, identity.userId));
  } catch (error) {
    return toErrorResponse(error);
  }
};
