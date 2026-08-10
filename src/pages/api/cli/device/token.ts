import type { APIRoute } from "astro";
import { deviceTokenSchema } from "../../../../lib/cli";
import { getClientKey, json, toErrorResponse } from "../../../../lib/http";
import { enforceNamedRateLimit } from "../../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../../lib/runtime";
import { exchangeDeviceAuthorization } from "../../../../services/cli-auth";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "AUTH_RATE_LIMIT", `cli-token:${getClientKey(context.request)}`);
    const input = deviceTokenSchema.parse(await context.request.json());
    return json(await exchangeDeviceAuthorization(env, input.deviceCode));
  } catch (error) {
    return toErrorResponse(error);
  }
};
