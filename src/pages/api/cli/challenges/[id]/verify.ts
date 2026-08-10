import type { APIRoute } from "astro";
import { cliChallengeIdSchema, cliChallengeVerificationSchema } from "../../../../../lib/cli";
import { HttpError, getClientKey, json, toErrorResponse } from "../../../../../lib/http";
import { enforceNamedRateLimit } from "../../../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../../../lib/runtime";
import { verifyTurnstile } from "../../../../../lib/turnstile";
import { requireIdentity } from "../../../../../services/auth";
import { completeCliTurnstileChallenge, getCliTurnstileChallengeForBrowser } from "../../../../../services/cli-turnstile";

export const prerender = false;

/** Browser-only completion endpoint. The browser session, not the CLI bearer token, proves account ownership. */
export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "FEEDBACK_RATE_LIMIT", `cli-verify:${getClientKey(context.request)}`);
    const origin = context.request.headers.get("origin");
    const allowedOrigins = new Set([new URL(env.BETTER_AUTH_URL).origin, new URL(context.request.url).origin]);
    if (!origin || !allowedOrigins.has(origin)) {
      throw new HttpError(403, "invalid_origin", "The verification request did not come from this site.");
    }
    const identity = await requireIdentity(context.request, env);
    const challengeId = cliChallengeIdSchema.parse(context.params.id);
    const input = cliChallengeVerificationSchema.parse(await context.request.json());
    const challenge = await getCliTurnstileChallengeForBrowser(env, challengeId, identity.userId);
    if (challenge.requiresTurnstile && challenge.status === "pending") {
      await verifyTurnstile({
        request: context.request,
        env,
        token: input.turnstileToken,
        expectedHostname: new URL(context.request.url).hostname
      });
    }
    return json({ ok: true, challenge: await completeCliTurnstileChallenge(env, challengeId, identity.userId) });
  } catch (error) {
    return toErrorResponse(error);
  }
};
