import type { APIRoute } from "astro";
import { telemetryBatchSchema, telemetryDeleteSchema } from "../../../lib/telemetry";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireCliIdentity } from "../../../services/cli-auth";
import { deleteTelemetry, ingestTelemetry } from "../../../services/telemetry";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "TELEMETRY_RATE_LIMIT", `cli-telemetry:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "usage:write");
    const batch = telemetryBatchSchema.parse(await context.request.json());
    return json(await ingestTelemetry(env, identity, batch), { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const DELETE: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "TELEMETRY_RATE_LIMIT", `cli-telemetry-delete:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "usage:write");
    const input = telemetryDeleteSchema.parse(await context.request.json().catch(() => ({})));
    return json({ deleted: true, ...(await deleteTelemetry(env, identity, input.includeSubscriptions)) });
  } catch (error) {
    return toErrorResponse(error);
  }
};
