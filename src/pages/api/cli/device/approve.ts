import type { APIRoute } from "astro";
import { deviceApprovalSchema } from "../../../../lib/cli";
import { HttpError, getClientKey, json, toErrorResponse } from "../../../../lib/http";
import { enforceNamedRateLimit } from "../../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../../lib/runtime";
import { requireIdentity } from "../../../../services/auth";
import { approveDeviceAuthorization, requireCliIdentity } from "../../../../services/cli-auth";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "AUTH_RATE_LIMIT", `cli-approve:${getClientKey(context.request)}`);
    const bearerRequest = context.request.headers.get("authorization")?.startsWith("Bearer ") === true;
    if (!bearerRequest) {
      const origin = context.request.headers.get("origin");
      const allowedOrigins = new Set([new URL(env.BETTER_AUTH_URL).origin, new URL(context.request.url).origin]);
      if (!origin || !allowedOrigins.has(origin)) {
        throw new HttpError(403, "invalid_origin", "The authorization request did not come from this site.");
      }
    }
    const identity = bearerRequest
      ? await requireCliIdentity(context.request, env, "allowance:read")
      : await requireIdentity(context.request, env);
    const contentType = context.request.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await context.request.json()
      : Object.fromEntries((await context.request.formData()).entries());
    const input = deviceApprovalSchema.parse(body);
    return json({ ok: true, ...(await approveDeviceAuthorization(env, identity, input.userCode)) });
  } catch (error) {
    return toErrorResponse(error);
  }
};
