import type { APIRoute } from "astro";
import { z } from "zod";
import { updateProfilePreferences } from "../../db/repositories";
import { HttpError, appendSetCookie, getClientKey, json, toErrorResponse } from "../../lib/http";
import { enforceNamedRateLimit } from "../../lib/rate-limit";
import { invalidatePublicProfileEdgeCache } from "../../lib/cache";
import { getRuntimeEnv } from "../../lib/runtime";
import { isXUsername, normalizeXUsername } from "../../lib/security";
import { DEVELOPMENT_USER_COOKIE, getCurrentIdentity, isAdministratorIdentity, requireIdentity } from "../../services/auth";

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
    const updated = await updateProfilePreferences(env, identity.userId, { publicProfileEnabled: input.publicProfileEnabled, xUsername });
    if (!updated) {
      return json({ error: { code: "account_unavailable", message: "This account is no longer available." } }, { status: 409 });
    }
    await invalidatePublicProfileEdgeCache(env.BETTER_AUTH_URL, identity.profile.githubUsername);
    return json({ publicProfileEnabled: input.publicProfileEnabled, xUsername });
  } catch (error) {
    return toErrorResponse(error);
  }
};

const deletionSchema = z.object({ confirmation: z.string().trim().min(1).max(39) }).strict();

export const DELETE: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "AUTH_RATE_LIMIT", `profile-delete:${getClientKey(context.request)}`);
    const identity = await getCurrentIdentity(context.request, env);
    if (!identity) throw new HttpError(401, "authentication_required", "Sign in with GitHub to delete your account.");
    if (identity.profile.status === "deleted") {
      return json({ error: { code: "account_unavailable", message: "This account is already unavailable." } }, { status: 409 });
    }
    const input = deletionSchema.parse(await context.request.json());
    if (input.confirmation !== identity.profile.githubUsername) {
      return json({ error: { code: "confirmation_mismatch", message: `Type ${identity.profile.githubUsername} exactly to confirm.` } }, { status: 422 });
    }
    if (isAdministratorIdentity(identity, env)) {
      return json({ error: { code: "administrator_deletion_blocked", message: "Administrators must be demoted and removed from the administrator allowlist before deleting their account." } }, { status: 409 });
    }
    const response = await env.FEEDBACK_ALLOWANCE.get(env.FEEDBACK_ALLOWANCE.idFromName(identity.userId)).fetch("https://feedback-allowance/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: identity.userId, now: Date.now() })
    });
    const outcome = await response.json() as { deleted?: boolean; code?: string; previousUsername?: string };
    if (!response.ok || !outcome.deleted || !outcome.previousUsername) {
      const administratorBlocked = outcome.code === "administrator_deletion_blocked";
      return json({
        error: {
          code: outcome.code ?? "account_deletion_failed",
          message: administratorBlocked
            ? "Administrators must be demoted and removed from the administrator allowlist before deleting their account."
            : "Your account could not be deleted because it is no longer available."
        }
      }, { status: response.status });
    }
    await invalidatePublicProfileEdgeCache(env.BETTER_AUTH_URL, outcome.previousUsername);
    const secure = env.BETTER_AUTH_URL.startsWith("https://") ? "; Secure" : "";
    return appendSetCookie(
      json({ deleted: true }),
      `${DEVELOPMENT_USER_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
    );
  } catch (error) {
    return toErrorResponse(error);
  }
};
