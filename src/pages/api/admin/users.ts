import type { APIRoute } from "astro";
import { z } from "zod";
import { setUserStatus } from "../../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireAdministrator } from "../../../services/auth";

export const prerender = false;
const schema = z.object({ userId: z.uuid(), status: z.enum(["active", "suspended", "admin", "deleted"]) }).strict();

export const PATCH: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    const actor = await requireAdministrator(context.request, env);
    const input = schema.parse(await context.request.json());
    await setUserStatus({ env, ...input, actorUserId: actor.userId });
    return json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
};
