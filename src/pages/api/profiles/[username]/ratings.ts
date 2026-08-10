import type { APIRoute } from "astro";
import { z } from "zod";
import { getPublicProfileRatingsPage, getPublicProfileView } from "../../../../db/repositories";
import { getClientKey, json, toErrorResponse } from "../../../../lib/http";
import { enforceNamedRateLimit } from "../../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../../lib/runtime";
import { getCurrentIdentity } from "../../../../services/auth";

export const prerender = false;

const cursorSchema = z.string().regex(/^\d{1,16}:[A-Za-z0-9_-]{1,80}$/).nullable();

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", `profile-ratings:${getClientKey(context.request)}`);
    const username = context.params.username ?? "";
    const parsedCursor = cursorSchema.safeParse(new URL(context.request.url).searchParams.get("cursor"));
    if (!parsedCursor.success) {
      return json({ error: { code: "invalid_cursor", message: "The ratings cursor is invalid." } }, { status: 400 });
    }
    const identity = await getCurrentIdentity(context.request, env);
    const profile = await getPublicProfileView(env, username, identity?.userId ?? null);
    if (!profile) return json({ error: { code: "profile_not_found", message: "Profile not found." } }, { status: 404 });
    return json(await getPublicProfileRatingsPage(env, profile.userId, parsedCursor.data));
  } catch (error) {
    return toErrorResponse(error);
  }
};
