import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";
import type { CliIdentity } from "../../src/services/cli-auth";
import { ingestTelemetry, upsertUserSubscription } from "../../src/services/telemetry";
import { loadSubscriptionRanking, recalculateSubscriptionRankings } from "../../src/services/subscription-aggregation";
import { prepareTestDatabase } from "./setup";

const runtime = env as unknown as Env;
const planId = "30000000-0000-4000-8000-000000000001";
const cursorPlanId = "30000000-0000-4000-8000-000000000003";
const satisfactionPrivacyPlanId = "30000000-0000-4000-8000-000000000004";

const identityFor = async (suffix: number): Promise<CliIdentity> => {
  const now = Date.now();
  const userId = `telemetry-user-${suffix}`;
  const installationId = `telemetry-installation-${suffix}`;
  await runtime.DB.batch([
    runtime.DB.prepare("insert or ignore into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)")
      .bind(userId, `User ${suffix}`, `${userId}@test.invalid`, now, now),
    runtime.DB.prepare("insert or ignore into user_profile (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at) values (?, ?, ?, ?, 'normal', 1, 'active', ?, ?)")
      .bind(userId, `github-${suffix}`, `telemetry-${suffix}`, now - 365 * 86_400_000, now, now),
    runtime.DB.prepare("insert or ignore into cli_installation (id, user_id, label, token_hash, scopes_json, created_at, expires_at) values (?, ?, 'test', ?, '[]', ?, ?)")
      .bind(installationId, userId, `token-${suffix}`, now, now + 86_400_000)
  ]);
  return {
    userId, installationId, name: `User ${suffix}`, image: null, isDevelopmentMock: false, scopes: [],
    profile: {
      userId, githubUserId: `github-${suffix}`, githubUsername: `telemetry-${suffix}`,
      githubDisplayName: null, githubAvatarUrl: null, githubAccountCreatedAt: now - 365 * 86_400_000,
      xUsername: null, trustCategory: "normal", trustWeight: 1, status: "active",
      publicProfileEnabled: false, firstLoginAt: now, lastLoginAt: now, deletedAt: null
    }
  };
};

beforeAll(async () => {
  await prepareTestDatabase(runtime);
  const now = Date.now();
  await runtime.DB.batch([
    runtime.DB.prepare("insert or ignore into subscription_plan (id, slug, provider_name, name, billing_period, price_micros, currency, official_url, is_active, created_at, updated_at) values (?, 'test-claude-plan', 'Anthropic', 'Test Claude Plan', 'monthly', 20000000, 'USD', 'https://example.com/plan', 1, ?, ?)")
      .bind(planId, now, now),
    runtime.DB.prepare("insert or ignore into model_price (id, provider_name, model_key, display_name, input_micros_per_million, cache_read_micros_per_million, cache_write_micros_per_million, output_micros_per_million, reasoning_micros_per_million, source_url, effective_from, created_at) values (?, 'Anthropic', 'claude-opus-test', 'Claude Opus Test', 10000000, 1000000, 12000000, 20000000, 20000000, 'https://example.com/price', 1, ?)")
      .bind("30000000-0000-4000-8000-000000000002", now),
    runtime.DB.prepare("insert or ignore into subscription_plan (id, slug, provider_name, name, billing_period, price_micros, currency, official_url, is_active, created_at, updated_at) values (?, 'test-cursor-plan', 'Cursor', 'Test Cursor Plan', 'monthly', 20000000, 'USD', 'https://example.com/cursor', 1, ?, ?)")
      .bind(cursorPlanId, now, now),
    runtime.DB.prepare("insert or ignore into subscription_plan (id, slug, provider_name, name, billing_period, price_micros, currency, official_url, is_active, created_at, updated_at) values (?, 'test-satisfaction-privacy', 'Cursor', 'Test Satisfaction Privacy', 'monthly', 20000000, 'USD', 'https://example.com/privacy', 1, ?, ?)")
      .bind(satisfactionPrivacyPlanId, now, now)
  ]);
});

describe("subscription telemetry", () => {
  it("keeps mixed model effort slices and idempotently rejects repeated requests", async () => {
    const identity = await identityFor(50);
    const clientSubscriptionId = crypto.randomUUID();
    await upsertUserSubscription(runtime, identity, {
      clientSubscriptionId, providerName: "Anthropic", planLabel: "Test Claude Plan", planSlug: "test-claude-plan",
      billingPeriod: "monthly", priceMicros: 20_000_000, currency: "USD", aggregateConsent: true
    });
    const sessionHash = "a".repeat(43);
    const requestHash = "b".repeat(43);
    const base = {
      clientSubscriptionId, tool: "claude-code" as const, sessionHash, requestHash,
      reportedModel: "claude-opus-test", reasoningEffort: "high", querySource: "main" as const,
      granularity: "request" as const, attributionQuality: "exact" as const,
      inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 5,
      reportedTotalTokens: 30, observedAt: Date.now(), collectorVersion: "0.3.0"
    };
    expect(await ingestTelemetry(runtime, identity, { usage: [{ ...base, clientEventId: crypto.randomUUID() }], quota: [] })).toEqual({ accepted: 1, duplicates: 0 });
    expect(await ingestTelemetry(runtime, identity, { usage: [{ ...base, clientEventId: crypto.randomUUID() }], quota: [] })).toEqual({ accepted: 0, duplicates: 1 });
    await expect(upsertUserSubscription(runtime, identity, {
      clientSubscriptionId, providerName: "Anthropic", planLabel: "Test Claude Plan", planSlug: "test-claude-plan",
      billingPeriod: "monthly", priceMicros: 20_000_000, currency: "USD", aggregateConsent: true,
      startedAt: Date.now() - 1_000
    })).rejects.toMatchObject({ status: 409, code: "subscription_has_telemetry" });
  });

  it("rejects telemetry from a tool that does not belong to the selected market provider", async () => {
    const identity = await identityFor(51);
    const clientSubscriptionId = crypto.randomUUID();
    await upsertUserSubscription(runtime, identity, {
      clientSubscriptionId, providerName: "Cursor", planLabel: "Test Cursor Plan", planSlug: "test-cursor-plan",
      billingPeriod: "monthly", priceMicros: 20_000_000, currency: "USD", aggregateConsent: true
    });
    const usage = {
      clientEventId: crypto.randomUUID(), clientSubscriptionId, tool: "codex" as const,
      sessionHash: "c".repeat(43), requestHash: "d".repeat(43), reportedModel: "cursor-test",
      querySource: "main" as const, granularity: "request" as const, attributionQuality: "exact" as const,
      inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 20, reasoningTokens: 0,
      observedAt: Date.now(), collectorVersion: "0.3.0"
    };
    await expect(ingestTelemetry(runtime, identity, { usage: [usage], quota: [] }))
      .rejects.toMatchObject({ status: 422, code: "subscription_provider_mismatch" });
  });

  it("publishes only model-effort dimensions that independently reach five contributors", async () => {
    const now = Date.now();
    for (let suffix = 1; suffix <= 10; suffix += 1) {
      const identity = await identityFor(suffix);
      const clientSubscriptionId = crypto.randomUUID();
      await upsertUserSubscription(runtime, identity, {
        clientSubscriptionId, providerName: "Anthropic", planLabel: "Test Claude Plan", planSlug: "test-claude-plan",
        billingPeriod: "monthly", priceMicros: 20_000_000, currency: "USD", aggregateConsent: true
      }, now);
      await ingestTelemetry(runtime, identity, { usage: [{
        clientEventId: crypto.randomUUID(), clientSubscriptionId, tool: "claude-code",
        sessionHash: String(suffix).repeat(43).slice(0, 43), requestHash: String(suffix + 1).repeat(43).slice(0, 43),
        reportedModel: "claude-opus-test", reasoningEffort: suffix % 2 ? "high" : "xhigh",
        querySource: "main", granularity: "request", attributionQuality: "exact",
        inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1_000_000,
        reasoningTokens: 500_000, reportedTotalTokens: 1_000_000, observedAt: now, collectorVersion: "0.3.0"
      }], quota: [] }, now);
    }
    await recalculateSubscriptionRankings(runtime, now);
    const ranking = await loadSubscriptionRanking(runtime, "7d", now);
    const item = ranking.items.find(({ id }) => id === planId);
    expect(item).toMatchObject({ contributorCount: 11, subscriptionCount: 11 });
    expect(item?.allowanceValueScore).toBeCloseTo(81.1, 1);
    expect(item?.modelMix.map(({ reasoningEffort }) => reasoningEffort).sort()).toEqual(["high", "xhigh"]);
  });

  it("keeps optional satisfaction separate and attaches it directly to the configured subscription", async () => {
    const now = Date.now();
    const itemId = "30000000-0000-4000-8000-000000000099";
    await runtime.DB.prepare(
      "insert or ignore into tracked_item (id, name, slug, provider_name, type, official_url, is_active, sort_order, created_at, updated_at) values (?, 'Claude Test', 'claude-test', 'Anthropic', 'model', 'https://example.com/model', 1, 0, ?, ?)"
    ).bind(itemId, now, now).run();
    for (let suffix = 1; suffix <= 5; suffix += 1) {
      const userId = `telemetry-user-${suffix}`;
      const subscription = await runtime.DB.prepare(
        "select id from user_subscription where user_id = ? and plan_id = ? limit 1"
      ).bind(userId, planId).first<{ id: string }>();
      expect(subscription).not.toBeNull();
      const contextId = crypto.randomUUID();
      const reportId = crypto.randomUUID();
      await runtime.DB.batch([
        runtime.DB.prepare(
          `insert into feedback_context
            (id, user_id, installation_id, subscription_id, tracked_item_id, session_hash, tool,
             raw_model_label, attribution, adapter_version, session_duration_bucket, created_at)
           values (?, ?, ?, ?, ?, ?, 'claude-code', 'claude-opus-test', 'verified_active', '0.3.0', '10_30m', ?)`
        ).bind(contextId, userId, `telemetry-installation-${suffix}`, subscription!.id, itemId, `satisfaction-${suffix}`.padEnd(43, "x"), now),
        runtime.DB.prepare(
          `insert into feedback_report
            (id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json,
             effective_weight, moderation_status, fraud_risk_score, included_in_scores,
             duplicate_cluster_adjustment, idempotency_key, source, feedback_context_id,
             submitted_at, created_at, updated_at)
           values (?, ?, ?, 4, 4, '[]', 1, 'approved', 0, 1, 1, ?, 'cli', ?, ?, ?, ?)`
        ).bind(reportId, userId, itemId, crypto.randomUUID(), contextId, now, now, now)
      ]);
    }
    await recalculateSubscriptionRankings(runtime, now);
    const item = (await loadSubscriptionRanking(runtime, "7d", now)).items.find(({ id }) => id === planId);
    expect(item?.satisfactionScore).toBe(75);
    expect(item?.satisfactionCount).toBe(5);
    expect(item?.allowanceValueScore).toBeCloseTo(81.1, 1);
  });

  it("does not let repeated check-ins from one person satisfy the privacy threshold or affect rank", async () => {
    const now = Date.now();
    const itemId = "30000000-0000-4000-8000-000000000098";
    await runtime.DB.prepare(
      "insert or ignore into tracked_item (id, name, slug, provider_name, type, official_url, is_active, sort_order, created_at, updated_at) values (?, 'Privacy Test', 'privacy-test', 'Anthropic', 'model', 'https://example.com/privacy-model', 1, 0, ?, ?)"
    ).bind(itemId, now, now).run();
    let firstSubscriptionId = "";
    for (let suffix = 80; suffix < 85; suffix += 1) {
      const identity = await identityFor(suffix);
      const clientSubscriptionId = crypto.randomUUID();
      const subscription = await upsertUserSubscription(runtime, identity, {
        clientSubscriptionId, providerName: "Cursor", planLabel: "Test Satisfaction Privacy", planSlug: "test-satisfaction-privacy",
        billingPeriod: "monthly", priceMicros: 20_000_000, currency: "USD", aggregateConsent: true
      }, now);
      if (suffix === 80) firstSubscriptionId = subscription.id;
      await ingestTelemetry(runtime, identity, { usage: [{
        clientEventId: crypto.randomUUID(), clientSubscriptionId, tool: "cursor",
        sessionHash: `${suffix}`.repeat(43).slice(0, 43), requestHash: `${suffix + 1}`.repeat(43).slice(0, 43),
        reportedModel: "claude-opus-test", querySource: "main", granularity: "request", attributionQuality: "exact",
        inputTokens: 1_000_000, cacheReadTokens: 800_000, cacheWriteTokens: 0, outputTokens: 1_000_000,
        reasoningTokens: 0, observedAt: now, collectorVersion: "0.3.0"
      }], quota: [] }, now);
    }
    for (let report = 0; report < 5; report += 1) {
      const contextId = crypto.randomUUID();
      await runtime.DB.batch([
        runtime.DB.prepare(
          `insert into feedback_context
            (id, user_id, installation_id, subscription_id, tracked_item_id, session_hash, tool,
             raw_model_label, attribution, adapter_version, session_duration_bucket, created_at)
           values (?, 'telemetry-user-80', 'telemetry-installation-80', ?, ?, ?, 'cursor',
             'claude-opus-test', 'verified_active', '0.3.0', '10_30m', ?)`
        ).bind(contextId, firstSubscriptionId, itemId, `privacy-satisfaction-${report}`.padEnd(43, "x"), now),
        runtime.DB.prepare(
          `insert into feedback_report
            (id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json,
             effective_weight, moderation_status, fraud_risk_score, included_in_scores,
             duplicate_cluster_adjustment, idempotency_key, source, feedback_context_id,
             submitted_at, created_at, updated_at)
           values (?, 'telemetry-user-80', ?, 1, 1, '[]', 1, 'approved', 0, 1, 1, ?, 'cli', ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), itemId, crypto.randomUUID(), contextId, now, now, now)
      ]);
    }

    await recalculateSubscriptionRankings(runtime, now);
    const item = (await loadSubscriptionRanking(runtime, "7d", now)).items.find(({ id }) => id === satisfactionPrivacyPlanId);
    expect(item?.contributorCount).toBe(5);
    expect(item?.satisfactionScore).toBeNull();
    expect(item?.satisfactionCount).toBe(0);
    expect(item?.medianTokensPerSubscription).toBe(2_000_000);
    expect(item?.apiEquivalentMicros).toBe(22_800_000);
    const allowance = item?.allowanceValueScore ?? 0;
    const confidence = item?.confidence ?? 0;
    expect(item?.qualityAdjustedValueScore).toBeCloseTo(50 + (allowance - 50) * confidence / 100, 1);
  });
});
