import type { APIRoute } from "astro";
import { deviceStartSchema } from "../../../../lib/cli";
import { getClientKey, json, toErrorResponse } from "../../../../lib/http";
import { enforceNamedRateLimit } from "../../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../../lib/runtime";
import { startDeviceAuthorization } from "../../../../services/cli-auth";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "AUTH_RATE_LIMIT", `cli-start:${getClientKey(context.request)}`);
    const input = deviceStartSchema.parse(await context.request.json().catch(() => ({})));
    return json(await startDeviceAuthorization(env, input.clientName), { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
};
