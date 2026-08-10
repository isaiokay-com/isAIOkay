import type { APIRoute } from "astro";
import { cliChallengeIdSchema } from "../../../../lib/cli";
import { getClientKey, json, toErrorResponse } from "../../../../lib/http";
import { enforceNamedRateLimit } from "../../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../../lib/runtime";
import { requireCliIdentity } from "../../../../services/cli-auth";
import { getCliTurnstileChallengeForCli } from "../../../../services/cli-turnstile";

export const prerender = false;

/** Polling endpoint for the CLI bearer credential that issued the challenge. */
export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "FEEDBACK_MODAL_RATE_LIMIT", `cli-verify-status:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "feedback:write");
    const challengeId = cliChallengeIdSchema.parse(context.params.id);
    return json(await getCliTurnstileChallengeForCli(env, challengeId, identity));
  } catch (error) {
    return toErrorResponse(error);
  }
};
