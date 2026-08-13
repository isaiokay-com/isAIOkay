import type { APIRoute } from "astro";
import { getActiveItemById, getDuplicateClusterSignal, getLatestEditableFeedbackReport, getSettings, getSuspicion, reportCountSince } from "../../db/repositories";
import { stableHash } from "../../lib/crypto";
import { feedbackEditInputSchema, feedbackInputSchema } from "../../lib/feedback";
import { getClientKey, json, toErrorResponse } from "../../lib/http";
import { enforceNamedRateLimit } from "../../lib/rate-limit";
import { getRuntimeEnv } from "../../lib/runtime";
import { needsTurnstile, verifyTurnstile } from "../../lib/turnstile";
import { trustForAccountAge } from "../../lib/trust";
import { requireIdentity } from "../../services/auth";
import type { EditableFeedbackReport, FeedbackAllowance } from "../../types";

export const prerender = false;

interface AllowanceOutcome {
  accepted: boolean;
  idempotent: boolean;
  code?: string;
  reportId?: string;
  allowance: FeedbackAllowance;
}

interface EditOutcome {
  edited: boolean;
  code?: string;
  reportId?: string;
  allowance: FeedbackAllowance;
}

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "FEEDBACK_MODAL_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireIdentity(context.request, env);
    const now = Date.now();
    const [settings, suspicious, latestEditableReport] = await Promise.all([
      getSettings(env),
      getSuspicion(env, identity.userId),
      getLatestEditableFeedbackReport(env, identity.userId, now)
    ]);
    const requestedItemId = new URL(context.request.url).searchParams.get("trackedItemId");
    const editableReport: EditableFeedbackReport | null = latestEditableReport?.trackedItemId === requestedItemId
      ? latestEditableReport
      : null;
    return json({
      authenticated: true,
      siteKey: env.TURNSTILE_SITE_KEY ?? null,
      editableReport,
      requiresTurnstile: needsTurnstile({
        accountCreatedAt: identity.profile.githubAccountCreatedAt,
        suspicious,
        abnormalVelocity: false,
        now,
        settings
      })
    });
  } catch (error) {
    return toErrorResponse(error);
  }
};

const editErrorMessages: Record<string, string> = {
  account_unavailable: "This account is no longer available.",
  edit_not_latest: "Only your latest rating can be edited.",
  edit_expired: "The 10-minute edit window has expired.",
  edit_already_used: "This rating has already used its one edit."
};

export const PATCH: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "FEEDBACK_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireIdentity(context.request, env);
    const input = feedbackEditInputSchema.parse(await context.request.json());
    if (input.agentItemId) {
      const agent = await getActiveItemById(env, input.agentItemId);
      if (!agent?.isActive || agent.type !== "agent") {
        return json({ error: { code: "unknown_agent", message: "That coding agent is not available as report context." } }, { status: 422 });
      }
    }

    const objectId = env.FEEDBACK_ALLOWANCE.idFromName(identity.userId);
    const response = await env.FEEDBACK_ALLOWANCE.get(objectId).fetch("https://feedback-allowance/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: identity.userId, now: Date.now(), report: input })
    });
    const outcome = await response.json() as EditOutcome;
    if (!response.ok || !outcome.edited) {
      const code = outcome.code ?? "edit_failed";
      return json({ ...outcome, error: { code, message: editErrorMessages[code] ?? "Your rating could not be updated." } }, { status: response.status });
    }
    return json(outcome);
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "FEEDBACK_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireIdentity(context.request, env);
    const input = feedbackInputSchema.parse(await context.request.json());
    const item = await getActiveItemById(env, input.trackedItemId);
    if (!item?.isActive || item.type !== "model") return json({ error: { code: "unknown_model", message: "That model is not available for feedback." } }, { status: 404 });
    if (input.agentItemId) {
      const agent = await getActiveItemById(env, input.agentItemId);
      if (!agent?.isActive || agent.type !== "agent") {
        return json({ error: { code: "unknown_agent", message: "That coding agent is not available as report context." } }, { status: 422 });
      }
    }

    const now = Date.now();
    const settings = await getSettings(env);
    const trust = trustForAccountAge(identity.profile.githubAccountCreatedAt, settings, now);
    if (trust.blocked || identity.profile.trustCategory === "blocked") {
      return json({ error: { code: "github_account_too_new", message: "GitHub accounts younger than the configured minimum cannot report yet." } }, { status: 403 });
    }
    const ipHash = await stableHash(env.BETTER_AUTH_SECRET, getClientKey(context.request));
    const deviceMaterial = input.deviceId ?? context.request.headers.get("user-agent") ?? "unknown";
    const deviceHash = await stableHash(env.BETTER_AUTH_SECRET, deviceMaterial);
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
      await verifyTurnstile({ request: context.request, env, token: input.turnstileToken, expectedHostname: new URL(context.request.url).hostname });
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
          trackedItemId: input.trackedItemId,
          agentItemId: input.agentItemId ?? null,
          resultQualityRating: input.resultQualityRating,
          usageEfficiencyRating: input.usageEfficiencyRating,
          tags: input.tags,
          shortComment: input.shortComment,
          idempotencyKey: input.idempotencyKey
        },
        effectiveWeight: trust.trustWeight,
        fraudRiskScore,
        duplicateClusterAdjustment: cluster.adjustment,
        ipHash,
        deviceHash
      })
    });
    const outcome = await response.json() as AllowanceOutcome;
    const editableReport = outcome.accepted && outcome.reportId
      ? await getLatestEditableFeedbackReport(env, identity.userId, now)
      : null;
    return json({ ...outcome, editableReport }, { status: response.status });
  } catch (error) {
    return toErrorResponse(error);
  }
};
