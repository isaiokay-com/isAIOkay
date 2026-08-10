import type { APIRoute } from "astro";
import { getDuplicateClusterSignal, getSettings, getSuspicion, reportCountSince } from "../../../db/repositories";
import { cliFeedbackInputSchema } from "../../../lib/cli";
import { stableHash } from "../../../lib/crypto";
import { HttpError, getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { needsTurnstile } from "../../../lib/turnstile";
import { trustForAccountAge } from "../../../lib/trust";
import { requireCliIdentity } from "../../../services/cli-auth";
import { resolveCliAgentItemId, resolveCliTrackedItem } from "../../../services/cli-feedback";
import { consumeCliTurnstileChallenge, issueCliTurnstileChallenge } from "../../../services/cli-turnstile";
import type { FeedbackAllowance } from "../../../types";

export const prerender = false;

interface AllowanceOutcome {
  accepted: boolean;
  idempotent: boolean;
  code?: string;
  reportId?: string;
  allowance: FeedbackAllowance;
}

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "FEEDBACK_RATE_LIMIT", `cli:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "feedback:write");
    const input = cliFeedbackInputSchema.parse(await context.request.json());
    const resolved = await resolveCliTrackedItem(env, input);
    const agentItemId = await resolveCliAgentItemId(env, input);
    const now = Date.now();
    const settings = await getSettings(env);
    const trust = trustForAccountAge(identity.profile.githubAccountCreatedAt, settings, now);
    if (trust.blocked || identity.profile.trustCategory === "blocked") {
      throw new HttpError(403, "github_account_too_new", "GitHub accounts younger than the configured minimum cannot report yet.");
    }

    const ipHash = await stableHash(env.BETTER_AUTH_SECRET, getClientKey(context.request));
    const deviceHash = await stableHash(env.BETTER_AUTH_SECRET, `cli:${identity.installationId}`);
    const cluster = await getDuplicateClusterSignal(env, identity.userId, ipHash, deviceHash, now - 24 * 60 * 60_000);
    const suspicious = (await getSuspicion(env, identity.userId, now)) || cluster.suspicious;
    const recentVelocity = await reportCountSince(env, identity.userId, now - 15 * 60_000) >= 2;
    if (needsTurnstile({
      accountCreatedAt: identity.profile.githubAccountCreatedAt,
      suspicious,
      abnormalVelocity: recentVelocity,
      now,
      settings
    })) {
      if (!input.challengeId || !input.challengeProof) {
        const challenge = await issueCliTurnstileChallenge(env, identity, now);
        throw new HttpError(428, "cli_verification_required", "Browser verification is required before this CLI report can be accepted.", {
          challengeId: challenge.id,
          verificationUrl: `${env.BETTER_AUTH_URL}/cli/verify/${challenge.id}`,
          statusUrl: `${env.BETTER_AUTH_URL}/api/cli/challenges/${challenge.id}`,
          expiresAt: new Date(challenge.expiresAt).toISOString()
        });
      }
      await consumeCliTurnstileChallenge(env, identity, input.challengeId, input.challengeProof, now);
    }

    const fraudRiskScore = suspicious ? 0.45 : recentVelocity ? 0.25 : cluster.adjustment < 1 ? 0.15 : 0;
    const objectId = env.FEEDBACK_ALLOWANCE.idFromName(identity.userId);
    const response = await env.FEEDBACK_ALLOWANCE.get(objectId).fetch("https://feedback-allowance/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: identity.userId,
        now,
        report: {
          trackedItemId: resolved.item.id,
          agentItemId,
          resultQualityRating: input.resultQualityRating,
          usageEfficiencyRating: input.usageEfficiencyRating,
          tags: input.tags,
          shortComment: input.shortComment,
          idempotencyKey: input.clientEventId
        },
        effectiveWeight: trust.trustWeight,
        fraudRiskScore,
        duplicateClusterAdjustment: cluster.adjustment,
        ipHash,
        deviceHash,
        cliContext: {
          installationId: identity.installationId,
          sessionHash: input.sessionHash,
          tool: input.tool,
          rawModelLabel: input.rawModelLabel ?? null,
          attribution: resolved.attribution,
          adapterVersion: input.adapterVersion,
          sessionDurationBucket: input.sessionDurationBucket,
          clientEventId: input.clientEventId
        }
      })
    });
    const outcome = await response.json() as AllowanceOutcome;
    return json({ ...outcome, item: resolved.item }, { status: response.status });
  } catch (error) {
    return toErrorResponse(error);
  }
};
