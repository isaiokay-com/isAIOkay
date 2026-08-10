import type { APIRoute } from "astro";
import { z } from "zod";
import { updateProfilePreferences } from "../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../lib/http";
import { enforceNamedRateLimit } from "../../lib/rate-limit";
import { invalidatePublicProfileEdgeCache } from "../../lib/cache";
import { getRuntimeEnv } from "../../lib/runtime";
import { isXUsername, normalizeXUsername } from "../../lib/security";
import { requireIdentity } from "../../services/auth";

export const prerender = false;

const profileSchema = z.object({
  publicProfileEnabled: z.boolean(),
  xUsername: z.string().max(16).nullable()
}).strict();

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", `profile:${getClientKey(context.request)}`);
    const identity = await requireIdentity(context.request, env);
    return json({
      githubUsername: identity.profile.githubUsername,
      xUsername: identity.profile.xUsername,
      publicProfileEnabled: identity.profile.publicProfileEnabled
    });
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const PATCH: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "AUTH_RATE_LIMIT", `profile:${getClientKey(context.request)}`);
    const identity = await requireIdentity(context.request, env);
    const input = profileSchema.parse(await context.request.json());
    const xUsername = input.xUsername === null || input.xUsername.trim() === "" ? null : normalizeXUsername(input.xUsername);
    if (xUsername !== null && !isXUsername(xUsername)) {
      return json({ error: { code: "invalid_x_username", message: "Enter a valid X username without the profile URL." } }, { status: 422 });
    }
    await updateProfilePreferences(env, identity.userId, { publicProfileEnabled: input.publicProfileEnabled, xUsername });
    await invalidatePublicProfileEdgeCache(env.BETTER_AUTH_URL, identity.profile.githubUsername);
    return json({ publicProfileEnabled: input.publicProfileEnabled, xUsername });
  } catch (error) {
    return toErrorResponse(error);
  }
};
