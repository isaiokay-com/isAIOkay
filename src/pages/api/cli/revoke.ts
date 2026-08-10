import type { APIRoute } from "astro";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireCliIdentity, revokeCliInstallation } from "../../../services/cli-auth";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "AUTH_RATE_LIMIT", `cli-revoke:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env);
    await revokeCliInstallation(env, identity);
    return json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
};
