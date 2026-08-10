import type { APIRoute } from "astro";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireCliIdentity } from "../../../services/cli-auth";
import { listCliTrackedItems } from "../../../services/cli-feedback";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", `cli-items:${getClientKey(context.request)}`);
    await requireCliIdentity(context.request, env, "allowance:read");
    return json({ items: await listCliTrackedItems(env) });
  } catch (error) {
    return toErrorResponse(error);
  }
};
