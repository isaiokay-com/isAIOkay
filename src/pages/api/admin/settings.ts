import type { APIRoute } from "astro";
import { getSettings, saveSettings } from "../../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { appSettingsSchema } from "../../../lib/settings";
import { requireAdministrator } from "../../../services/auth";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    await requireAdministrator(context.request, env);
    return json(await getSettings(env));
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const PUT: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireAdministrator(context.request, env);
    await saveSettings(env, appSettingsSchema.parse(await context.request.json()), identity.userId);
    return json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
};
