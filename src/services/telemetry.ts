import type { Env } from "../env";
import { HttpError } from "../lib/http";
import type { CliIdentity } from "./cli-auth";
import type { SubscriptionInput, TelemetryBatch } from "../lib/telemetry";
import { validateObservationTime } from "../lib/telemetry";

export interface UserSubscriptionRecord {
  id: string;
  clientSubscriptionId: string;
  planId: string | null;
  planSlug: string | null;
  providerName: string;
  planLabel: string;
  billingPeriod: "monthly" | "annual" | "weekly" | "other";
  priceMicros: number | null;
  currency: string;
  startedAt: number | null;
  endedAt: number | null;
  aggregateConsent: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MarketSubscriptionPlan {
  slug: string;
  providerName: string;
  name: string;
  billingPeriod: "monthly" | "annual" | "weekly" | "other";
  priceMicros: number | null;
  currency: string;
  officialUrl: string;
  termsVersion: string | null;
  termsLastVerifiedAt: number | null;
}

export const listMarketSubscriptionPlans = async (env: Env): Promise<MarketSubscriptionPlan[]> => {
  const rows = await env.DB.prepare(
    `select slug, provider_name as providerName, name, billing_period as billingPeriod,
            price_micros as priceMicros, currency, official_url as officialUrl,
            terms_version as termsVersion, terms_last_verified_at as termsLastVerifiedAt
     from subscription_plan where is_active = 1 order by provider_name, price_micros, name`
  ).all<MarketSubscriptionPlan>();
  return rows.results;
};

export const listUserSubscriptions = async (env: Env, userId: string): Promise<UserSubscriptionRecord[]> => {
  const rows = await env.DB.prepare(
    `select us.id, us.client_subscription_id as clientSubscriptionId, us.plan_id as planId,
            sp.slug as planSlug, us.provider_name as providerName, us.plan_label as planLabel,
            us.billing_period as billingPeriod, us.price_micros as priceMicros,
            us.currency, us.started_at as startedAt, us.ended_at as endedAt,
            us.aggregate_consent as aggregateConsent, us.created_at as createdAt, us.updated_at as updatedAt
     from user_subscription us left join subscription_plan sp on sp.id = us.plan_id
     where us.user_id = ? order by us.ended_at is not null, us.created_at asc`
  ).bind(userId).all<Omit<UserSubscriptionRecord, "aggregateConsent"> & { aggregateConsent: number }>();
  return rows.results.map((row) => ({ ...row, aggregateConsent: Boolean(row.aggregateConsent) }));
};

export const upsertUserSubscription = async (
  env: Env,
  identity: CliIdentity,
  input: SubscriptionInput,
  now = Date.now()
): Promise<UserSubscriptionRecord> => {
  const plan = input.planSlug
    ? await env.DB.prepare("select id, provider_name from subscription_plan where slug = ? and is_active = 1 limit 1")
      .bind(input.planSlug).first<{ id: string; provider_name: string }>()
    : null;
  if (input.planSlug && !plan) throw new HttpError(422, "unknown_subscription_plan", "That market subscription plan is not available.");
  if (plan && plan.provider_name.toLowerCase() !== input.providerName.toLowerCase()) {
    throw new HttpError(422, "subscription_provider_mismatch", "The selected plan belongs to a different provider.");
  }
  const existing = await env.DB.prepare(
    `select id, plan_id as planId, provider_name as providerName, started_at as startedAt
     from user_subscription where user_id = ? and client_subscription_id = ? limit 1`
  ).bind(identity.userId, input.clientSubscriptionId).first<{
    id: string; planId: string | null; providerName: string; startedAt: number | null;
  }>();
  if (existing) {
    const evidence = await env.DB.prepare(
      `select count(*) as count, max(observed_at) as lastObservedAt from (
         select observed_at from usage_slice where subscription_id = ?
         union all select observed_at from quota_snapshot where subscription_id = ?
       )`
    ).bind(existing.id, existing.id).first<{ count: number; lastObservedAt: number | null }>();
    const classificationChanged = existing.planId !== (plan?.id ?? null) ||
      existing.providerName.toLowerCase() !== input.providerName.toLowerCase() ||
      existing.startedAt !== (input.startedAt ?? null);
    if ((evidence?.count ?? 0) > 0 && classificationChanged) {
      throw new HttpError(409, "subscription_has_telemetry", "A subscription with telemetry cannot change provider, market plan, or start time. End it and add a new subscription instead.");
    }
    if (input.endedAt && evidence?.lastObservedAt && input.endedAt < evidence.lastObservedAt) {
      throw new HttpError(409, "subscription_end_before_telemetry", "The subscription cannot end before its latest observation.");
    }
  }
  const id = existing?.id ?? crypto.randomUUID();
  await env.DB.prepare(
    `insert into user_subscription
       (id, user_id, plan_id, client_subscription_id, provider_name, plan_label, billing_period,
        price_micros, currency, started_at, ended_at, aggregate_consent, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(user_id, client_subscription_id) do update set
       plan_id = excluded.plan_id, provider_name = excluded.provider_name,
       plan_label = excluded.plan_label, billing_period = excluded.billing_period,
       price_micros = excluded.price_micros, currency = excluded.currency,
       started_at = excluded.started_at, ended_at = excluded.ended_at,
       aggregate_consent = excluded.aggregate_consent, updated_at = excluded.updated_at`
  ).bind(
    id, identity.userId, plan?.id ?? null, input.clientSubscriptionId, input.providerName,
    input.planLabel, input.billingPeriod, input.priceMicros ?? null, input.currency,
    input.startedAt ?? null, input.endedAt ?? null, input.aggregateConsent ? 1 : 0, now, now
  ).run();
  const subscriptions = await listUserSubscriptions(env, identity.userId);
  const saved = subscriptions.find((subscription) => subscription.clientSubscriptionId === input.clientSubscriptionId);
  if (!saved) throw new HttpError(500, "subscription_save_failed", "The subscription could not be saved.");
  return saved;
};

interface SubscriptionLookup {
  id: string;
  planId: string | null;
  providerName: string;
  startedAt: number | null;
  endedAt: number | null;
}

const toolMatchesProvider = (tool: string, providerName: string): boolean => {
  if (tool === "opencode") return true;
  const provider = providerName.toLowerCase();
  const nativeToolByProvider: Record<string, string> = {
    openai: "codex",
    anthropic: "claude-code",
    xai: "grok-build",
    github: "copilot-cli",
    cursor: "cursor",
    kimi: "kimi-code",
    "moonshot ai": "kimi-code"
  };
  return nativeToolByProvider[provider] === tool;
};

const subscriptionMap = async (
  env: Env,
  userId: string,
  clientIds: string[]
): Promise<Map<string, SubscriptionLookup>> => {
  const unique = [...new Set(clientIds)];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `select id, plan_id as planId, client_subscription_id as clientId,
            provider_name as providerName, started_at as startedAt, ended_at as endedAt
     from user_subscription where user_id = ? and client_subscription_id in (${placeholders})`
  ).bind(userId, ...unique).all<SubscriptionLookup & { clientId: string }>();
  return new Map(rows.results.map((row) => [row.clientId, row]));
};

export const ingestTelemetry = async (
  env: Env,
  identity: CliIdentity,
  batch: TelemetryBatch,
  now = Date.now()
): Promise<{ accepted: number; duplicates: number }> => {
  const all = [...batch.usage, ...batch.quota];
  if (all.some((observation) => !validateObservationTime(observation.observedAt, now))) {
    throw new HttpError(422, "observation_time_out_of_range", "Telemetry must be no more than one year old and cannot be from the future.");
  }
  const subscriptions = await subscriptionMap(env, identity.userId, all.map((item) => item.clientSubscriptionId));
  for (const observation of all) {
    const subscription = subscriptions.get(observation.clientSubscriptionId);
    if (!subscription) throw new HttpError(422, "subscription_not_configured", "Configure the subscription before uploading telemetry.");
    if (subscription.startedAt !== null && observation.observedAt < subscription.startedAt) {
      throw new HttpError(422, "subscription_inactive", "Telemetry cannot be attached before a subscription started.");
    }
    if (subscription.endedAt !== null && observation.observedAt > subscription.endedAt) {
      throw new HttpError(422, "subscription_inactive", "Telemetry cannot be attached after a subscription ended.");
    }
  }
  for (const usage of batch.usage) {
    const subscription = subscriptions.get(usage.clientSubscriptionId)!;
    if (subscription.planId && !toolMatchesProvider(usage.tool, subscription.providerName)) {
      throw new HttpError(422, "subscription_provider_mismatch", "The observed tool does not match the selected market subscription provider.");
    }
  }

  let accepted = 0;
  let duplicates = 0;
  for (const usage of batch.usage) {
    const subscription = subscriptions.get(usage.clientSubscriptionId)!;
    const outcome = await env.DB.prepare(
      `insert or ignore into usage_slice
        (id, user_id, installation_id, subscription_id, client_event_id, tool, provider_name,
         session_hash, request_hash, requested_model, reported_model, model_family, model_version,
         reasoning_effort, model_variant, service_tier, query_source, granularity, attribution_quality,
         token_attribution_quality, model_attribution_quality, effort_attribution_quality,
         input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
         reported_total_tokens, observed_at, collector_version, ingested_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), identity.userId, identity.installationId, subscription.id, usage.clientEventId,
      usage.tool, subscription.providerName, usage.sessionHash ?? null, usage.requestHash ?? null,
      usage.requestedModel ?? null, usage.reportedModel, usage.modelFamily ?? null, usage.modelVersion ?? null,
      usage.reasoningEffort ?? null, usage.modelVariant ?? null, usage.serviceTier ?? null,
      usage.querySource, usage.granularity, usage.attributionQuality,
      usage.tokenAttributionQuality ?? usage.attributionQuality,
      usage.modelAttributionQuality ?? usage.attributionQuality,
      usage.effortAttributionQuality ?? (usage.reasoningEffort ? usage.attributionQuality : "unknown"),
      usage.inputTokens,
      usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, usage.reasoningTokens,
      usage.reportedTotalTokens ?? null, usage.observedAt, usage.collectorVersion, now
    ).run();
    if (outcome.meta.changes) accepted += 1;
    else duplicates += 1;
  }
  for (const quota of batch.quota) {
    const subscription = subscriptions.get(quota.clientSubscriptionId)!;
    const outcome = await env.DB.prepare(
      `insert or ignore into quota_snapshot
        (id, user_id, installation_id, subscription_id, client_event_id, quota_scope, window_kind,
         used_percent, remaining_percent, reset_at, attribution_quality, observed_at, collector_version, ingested_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      crypto.randomUUID(), identity.userId, identity.installationId, subscription.id, quota.clientEventId,
      quota.quotaScope, quota.windowKind, quota.usedPercent ?? null, quota.remainingPercent ?? null,
      quota.resetAt ?? null, quota.attributionQuality, quota.observedAt, quota.collectorVersion, now
    ).run();
    if (outcome.meta.changes) accepted += 1;
    else duplicates += 1;
  }
  return { accepted, duplicates };
};

export const deleteTelemetry = async (
  env: Env,
  identity: CliIdentity,
  includeSubscriptions: boolean
): Promise<{ usageDeleted: number; quotaDeleted: number; subscriptionsDeleted: number }> => {
  const usage = await env.DB.prepare("delete from usage_slice where user_id = ?").bind(identity.userId).run();
  const quota = await env.DB.prepare("delete from quota_snapshot where user_id = ?").bind(identity.userId).run();
  const subscriptions = includeSubscriptions
    ? await env.DB.prepare("delete from user_subscription where user_id = ?").bind(identity.userId).run()
    : null;
  return {
    usageDeleted: usage.meta.changes ?? 0,
    quotaDeleted: quota.meta.changes ?? 0,
    subscriptionsDeleted: subscriptions?.meta.changes ?? 0
  };
};
