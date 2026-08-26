import type { Env } from "../env";
import { SUBSCRIPTION_SCHEMA_VERSION, type PublicSubscriptionRankingPayload, type SubscriptionModelMix, type SubscriptionPeriod, type SubscriptionRankingItem } from "../types";

const PERIOD_MS: Record<SubscriptionPeriod, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000
};
const PERIODS = Object.keys(PERIOD_MS) as SubscriptionPeriod[];
const PRIVACY_MINIMUM_CONTRIBUTORS = 5;
const METHODOLOGY_VERSION = "subscription-value-v1";

interface PlanRow {
  id: string;
  slug: string;
  providerName: string;
  name: string;
  billingPeriod: SubscriptionRankingItem["billingPeriod"];
  priceMicros: number | null;
  currency: string;
  officialUrl: string;
  termsVersion: string | null;
  termsLastVerifiedAt: number | null;
}

interface UsageRow {
  planId: string;
  subscriptionId: string;
  userId: string;
  providerName: string;
  tool: string;
  reportedModel: string;
  reasoningEffort: string | null;
  querySource: string;
  attributionQuality: string;
  tokenAttributionQuality: string;
  modelAttributionQuality: string;
  effortAttributionQuality: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reportedTotalTokens: number | null;
  observedAt: number;
}

interface PriceRow {
  providerName: string;
  modelKey: string;
  inputRate: number;
  cacheReadRate: number;
  cacheWriteRate: number;
  outputRate: number;
  effectiveFrom: number;
  effectiveTo: number | null;
}

const utcDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
const round = (value: number, precision = 1): number => Number(value.toFixed(precision));
const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? Math.round(sorted[middle] ?? 0) : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
};
const observedTotal = (row: UsageRow): number => row.reportedTotalTokens
  ?? row.inputTokens + row.outputTokens + (row.tool === "claude-code" ? row.cacheReadTokens + row.cacheWriteTokens : 0);

const normalizedModelKeys = (model: string): string[] => {
  const normalized = model.toLowerCase();
  const tail = normalized.includes("/") ? normalized.slice(normalized.lastIndexOf("/") + 1) : normalized;
  return tail === normalized ? [normalized] : [normalized, tail];
};

const priceFor = (row: UsageRow, prices: PriceRow[]): PriceRow | null => {
  const keys = normalizedModelKeys(row.reportedModel);
  const candidates = prices.filter((price) =>
    keys.includes(price.modelKey.toLowerCase()) &&
    price.effectiveFrom <= row.observedAt && (price.effectiveTo === null || price.effectiveTo > row.observedAt)
  );
  const subscriptionProviderPrice = candidates.find((price) =>
    price.providerName.toLowerCase() === row.providerName.toLowerCase()
  );
  if (subscriptionProviderPrice) return subscriptionProviderPrice;
  // Cursor, OpenCode, and other aggregators sell access to models priced by a
  // different API provider. Use that rate only when the model key resolves to
  // one unambiguous provider; otherwise keep the value estimate pending.
  const candidateProviders = new Set(candidates.map(({ providerName }) => providerName.toLowerCase()));
  return candidateProviders.size === 1 ? candidates[0] ?? null : null;
};

const equivalentMicros = (row: UsageRow, price: PriceRow): number => {
  // Standardized harness counters include cached reads in input; native Claude
  // reports cache reads/writes separately. Canonicalize before pricing buckets.
  const exclusiveInput = row.tool === "claude-code"
    ? row.inputTokens
    : Math.max(0, row.inputTokens - row.cacheReadTokens - row.cacheWriteTokens);
  return Math.round((
    exclusiveInput * price.inputRate +
    row.cacheReadTokens * price.cacheReadRate +
    row.cacheWriteTokens * price.cacheWriteRate +
    row.outputTokens * price.outputRate
  ) / 1_000_000);
};

interface QuotaRow {
  planId: string;
  subscriptionId: string;
  quotaScope: string;
  resetAt: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  attributionQuality: string;
}

const completeQuotaWindows = (rows: QuotaRow[]): Map<string, number> => {
  const windows = new Map<string, number[]>();
  for (const row of rows) {
    if (row.resetAt === null || row.attributionQuality !== "exact") continue;
    const used = row.usedPercent ?? (row.remainingPercent === null ? null : 100 - row.remainingPercent);
    if (used === null) continue;
    const key = `${row.planId}\u0000${row.subscriptionId}\u0000${row.quotaScope}\u0000${row.resetAt}`;
    const values = windows.get(key) ?? [];
    values.push(used);
    windows.set(key, values);
  }
  const byPlan = new Map<string, number>();
  for (const [key, values] of windows) {
    if (Math.min(...values) <= 5 && Math.max(...values) >= 95) {
      const planId = key.split("\u0000", 1)[0]!;
      byPlan.set(planId, (byPlan.get(planId) ?? 0) + 1);
    }
  }
  return byPlan;
};

interface SatisfactionRow { planId: string; userId: string; rating: number }

interface StoredAggregateRow {
  planId: string;
  contributorCount: number;
  subscriptionCount: number;
  usageSliceCount: number;
  completeWindowCount: number;
  observedTokens: number;
  medianTokensPerSubscription: number | null;
  apiEquivalentMicros: number | null;
  allowanceValueScore: number | null;
  satisfactionScore: number | null;
  satisfactionCount: number;
  qualityAdjustedValueScore: number | null;
  confidence: number;
  exactSliceCount: number;
  changePercent: number | null;
  methodologyVersion: string;
  calculatedAt: number;
  snapshotDay: number;
}

interface StoredDimensionRow {
  planId: string;
  reportedModel: string;
  reasoningEffort: string;
  querySource: string;
  contributorCount: number;
  usageSliceCount: number;
  exactSliceCount: number;
  observedTokens: number;
  apiEquivalentMicros: number | null;
}

const buildPeriod = async (env: Env, period: SubscriptionPeriod, now: number): Promise<PublicSubscriptionRankingPayload> => {
  const periodStart = now - PERIOD_MS[period];
  const snapshotDay = utcDay(now);
  const [planResult, usageResult, priceResult, quotaResult, satisfactionResult] = await Promise.all([
    env.DB.prepare(
      `select id, slug, provider_name as providerName, name, billing_period as billingPeriod,
              price_micros as priceMicros, currency, official_url as officialUrl,
              terms_version as termsVersion, terms_last_verified_at as termsLastVerifiedAt
       from subscription_plan where is_active = 1 order by provider_name, name`
    ).all<PlanRow>(),
    env.DB.prepare(
      `select us.plan_id as planId, u.subscription_id as subscriptionId, u.user_id as userId,
              u.provider_name as providerName, u.tool, u.reported_model as reportedModel,
              u.reasoning_effort as reasoningEffort, u.query_source as querySource,
              u.attribution_quality as attributionQuality,
              u.token_attribution_quality as tokenAttributionQuality,
              u.model_attribution_quality as modelAttributionQuality,
              u.effort_attribution_quality as effortAttributionQuality,
              u.input_tokens as inputTokens,
              u.cache_read_tokens as cacheReadTokens, u.cache_write_tokens as cacheWriteTokens,
              u.output_tokens as outputTokens, u.reasoning_tokens as reasoningTokens,
              u.reported_total_tokens as reportedTotalTokens, u.observed_at as observedAt
       from usage_slice u join user_subscription us on us.id = u.subscription_id
       join user_profile profile on profile.user_id = u.user_id
       where us.plan_id is not null and us.aggregate_consent = 1
         and profile.status in ('active', 'admin') and profile.trust_category in ('normal', 'trusted')
         and u.observed_at >= ? and u.observed_at <= ?`
    ).bind(periodStart, now).all<UsageRow>(),
    env.DB.prepare(
      `select provider_name as providerName, model_key as modelKey,
              input_micros_per_million as inputRate, cache_read_micros_per_million as cacheReadRate,
              cache_write_micros_per_million as cacheWriteRate, output_micros_per_million as outputRate,
              effective_from as effectiveFrom, effective_to as effectiveTo
       from model_price where effective_from <= ? and (effective_to is null or effective_to > ?)`
    ).bind(now, periodStart).all<PriceRow>(),
    env.DB.prepare(
      `select us.plan_id as planId, q.subscription_id as subscriptionId, q.quota_scope as quotaScope,
              q.reset_at as resetAt, q.used_percent as usedPercent, q.remaining_percent as remainingPercent,
              q.attribution_quality as attributionQuality
       from quota_snapshot q join user_subscription us on us.id = q.subscription_id
       join user_profile profile on profile.user_id = q.user_id
       where us.plan_id is not null and us.aggregate_consent = 1
         and profile.status in ('active', 'admin') and profile.trust_category in ('normal', 'trusted')
         and q.observed_at >= ? and q.observed_at <= ?`
    ).bind(periodStart, now).all<QuotaRow>(),
    env.DB.prepare(
      `select us.plan_id as planId, fr.user_id as userId, fr.result_quality_rating as rating
       from feedback_report fr
       join feedback_context fc on fc.id = fr.feedback_context_id
       join user_subscription us on us.id = fc.subscription_id and us.user_id = fr.user_id
       join user_profile profile on profile.user_id = fr.user_id
       where us.plan_id is not null and us.aggregate_consent = 1
         and profile.status in ('active', 'admin') and profile.trust_category in ('normal', 'trusted')
         and fr.included_in_scores = 1
         and fr.moderation_status != 'excluded' and fr.submitted_at >= ? and fr.submitted_at <= ?
       group by us.plan_id, fr.id, fr.user_id, fr.result_quality_rating`
    ).bind(periodStart, now).all<SatisfactionRow>()
  ]);

  const completeWindows = completeQuotaWindows(quotaResult.results);
  const satisfactionRatingsByPlanAndUser = new Map<string, Map<string, number[]>>();
  for (const row of satisfactionResult.results) {
    const ratingsByUser = satisfactionRatingsByPlanAndUser.get(row.planId) ?? new Map<string, number[]>();
    const ratings = ratingsByUser.get(row.userId) ?? [];
    ratings.push(row.rating);
    ratingsByUser.set(row.userId, ratings);
    satisfactionRatingsByPlanAndUser.set(row.planId, ratingsByUser);
  }

  const usageByPlan = new Map<string, UsageRow[]>();
  for (const row of usageResult.results) {
    const rows = usageByPlan.get(row.planId) ?? [];
    rows.push(row);
    usageByPlan.set(row.planId, rows);
  }

  const publicItems: SubscriptionRankingItem[] = [];
  for (const plan of planResult.results) {
    const rows = usageByPlan.get(plan.id) ?? [];
    const contributors = new Set(rows.map(({ userId }) => userId));
    const subscriptions = new Set(rows.map(({ subscriptionId }) => subscriptionId));
    const exactSliceCount = rows.filter(({ tokenAttributionQuality, modelAttributionQuality }) =>
      tokenAttributionQuality === "exact" && modelAttributionQuality === "exact"
    ).length;
    const totals = {
      input: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      cacheRead: rows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
      cacheWrite: rows.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
      output: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      reasoning: rows.reduce((sum, row) => sum + row.reasoningTokens, 0),
      observed: rows.reduce((sum, row) => sum + observedTotal(row), 0)
    };
    const perSubscription = new Map<string, number>();
    for (const row of rows) perSubscription.set(row.subscriptionId, (perSubscription.get(row.subscriptionId) ?? 0) + observedTotal(row));
    const equivalentBySubscription = new Map<string, number>();
    const pricedTokensBySubscription = new Map<string, number>();
    const rowPrices = new Map<UsageRow, number | null>();
    for (const row of rows) {
      const price = priceFor(row, priceResult.results);
      const equivalent = price ? equivalentMicros(row, price) : null;
      rowPrices.set(row, equivalent);
      if (equivalent !== null) {
        pricedTokensBySubscription.set(row.subscriptionId, (pricedTokensBySubscription.get(row.subscriptionId) ?? 0) + observedTotal(row));
        equivalentBySubscription.set(row.subscriptionId, (equivalentBySubscription.get(row.subscriptionId) ?? 0) + equivalent);
      }
    }
    const reliableSubscriptionValues = [...subscriptions].flatMap((subscriptionId) => {
      const subscriptionTokens = perSubscription.get(subscriptionId) ?? 0;
      const coverage = subscriptionTokens === 0 ? 0 : (pricedTokensBySubscription.get(subscriptionId) ?? 0) / subscriptionTokens;
      const equivalent = equivalentBySubscription.get(subscriptionId);
      return coverage >= 0.8 && equivalent !== undefined ? [equivalent] : [];
    });
    const reliableEquivalent = subscriptions.size > 0 && reliableSubscriptionValues.length / subscriptions.size >= 0.8
      ? median(reliableSubscriptionValues)
      : null;
    // Model price rows are currently USD-denominated. Keep local-currency plans
    // visible, but do not publish a mathematically invalid value score until an
    // effective-dated FX normalization layer is available.
    const monthlyPlanPrice = plan.currency === "USD" && plan.priceMicros && plan.priceMicros > 0
      ? plan.billingPeriod === "annual" ? plan.priceMicros / 12
        : plan.billingPeriod === "weekly" ? plan.priceMicros * 52 / 12
          : plan.billingPeriod === "monthly" ? plan.priceMicros : null
      : null;
    const monthlyEquivalent = reliableEquivalent === null ? null : reliableEquivalent * (30 * 86_400_000 / PERIOD_MS[period]);
    const valueRatio = monthlyEquivalent !== null && monthlyPlanPrice !== null
      ? monthlyEquivalent / monthlyPlanPrice
      : null;
    // A bounded ratio retains ordering above break-even: 1x API-equivalent
    // value is 50, 2x is 66.7, and 10x is 90.9.
    const allowanceValueScore = valueRatio === null ? null : round(valueRatio / (1 + valueRatio) * 100);
    const satisfactionRatingsByUser = satisfactionRatingsByPlanAndUser.get(plan.id);
    const satisfactionByContributor = satisfactionRatingsByUser
      ? [...satisfactionRatingsByUser.values()].map((ratings) => ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length)
      : [];
    const satisfactionScore = satisfactionByContributor.length > 0
      ? round(satisfactionByContributor.reduce((sum, rating) => sum + (rating - 1) * 25, 0) / satisfactionByContributor.length)
      : null;
    const satisfactionContributorCount = satisfactionByContributor.length;
    const publicSatisfactionScore = satisfactionContributorCount >= PRIVACY_MINIMUM_CONTRIBUTORS
      ? satisfactionScore
      : null;
    const exactPercent = rows.length === 0 ? 0 : exactSliceCount / rows.length * 100;
    const confidence = round(Math.min(100,
      Math.min(1, contributors.size / 20) * 60 +
      Math.min(1, (completeWindows.get(plan.id) ?? 0) / 10) * 25 +
      exactPercent / 100 * 15
    ));
    const rawCombined = allowanceValueScore === null ? null : publicSatisfactionScore === null
      ? allowanceValueScore
      : allowanceValueScore * 0.75 + publicSatisfactionScore * 0.25;
    const qualityAdjustedValueScore = rawCombined === null ? null : round(50 + (rawCombined - 50) * confidence / 100);
    const previous = await env.DB.prepare(
      `select allowance_value_score as value from subscription_aggregate
       where plan_id = ? and period = ? and snapshot_day < ? and allowance_value_score is not null
       order by snapshot_day desc limit 1`
    ).bind(plan.id, period, snapshotDay).first<{ value: number }>();
    const changePercent = allowanceValueScore !== null && previous?.value
      ? round((allowanceValueScore - previous.value) / previous.value * 100)
      : null;

    await env.DB.prepare(
      `insert into subscription_aggregate
        (id, plan_id, period, period_start, period_end, contributor_count, subscription_count,
         usage_slice_count, exact_slice_count, complete_window_count, input_tokens, cache_read_tokens,
         cache_write_tokens, output_tokens, reasoning_tokens, observed_token_total,
         median_tokens_per_subscription, api_equivalent_micros, allowance_value_score,
         satisfaction_score, satisfaction_count, quality_adjusted_value_score, confidence,
         change_percent, methodology_version, snapshot_day, calculated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(plan_id, period, snapshot_day) do update set
         period_start=excluded.period_start, period_end=excluded.period_end,
         contributor_count=excluded.contributor_count, subscription_count=excluded.subscription_count,
         usage_slice_count=excluded.usage_slice_count, exact_slice_count=excluded.exact_slice_count,
         complete_window_count=excluded.complete_window_count, input_tokens=excluded.input_tokens,
         cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
         output_tokens=excluded.output_tokens, reasoning_tokens=excluded.reasoning_tokens,
         observed_token_total=excluded.observed_token_total,
         median_tokens_per_subscription=excluded.median_tokens_per_subscription,
         api_equivalent_micros=excluded.api_equivalent_micros,
         allowance_value_score=excluded.allowance_value_score, satisfaction_score=excluded.satisfaction_score,
         satisfaction_count=excluded.satisfaction_count, quality_adjusted_value_score=excluded.quality_adjusted_value_score,
         confidence=excluded.confidence, change_percent=excluded.change_percent,
         methodology_version=excluded.methodology_version, calculated_at=excluded.calculated_at`
    ).bind(
      crypto.randomUUID(), plan.id, period, periodStart, now, contributors.size, subscriptions.size,
      rows.length, exactSliceCount, completeWindows.get(plan.id) ?? 0, totals.input, totals.cacheRead,
      totals.cacheWrite, totals.output, totals.reasoning, totals.observed, median([...perSubscription.values()]),
      reliableEquivalent, allowanceValueScore, satisfactionScore, satisfactionContributorCount,
      qualityAdjustedValueScore, confidence, changePercent, METHODOLOGY_VERSION, snapshotDay, now
    ).run();

    const dimensions = new Map<string, UsageRow[]>();
    for (const row of rows) {
      const key = `${row.reportedModel}\u0000${row.reasoningEffort ?? "default/unknown"}\u0000${row.querySource}`;
      const entries = dimensions.get(key) ?? [];
      entries.push(row);
      dimensions.set(key, entries);
    }
    const modelMix: SubscriptionModelMix[] = [];
    for (const [key, entries] of dimensions) {
      const [model, reasoningEffort, querySource] = key.split("\u0000") as [string, string, string];
      const dimensionTokens = entries.reduce((sum, row) => sum + observedTotal(row), 0);
      const dimensionEquivalentValues = entries.map((row) => rowPrices.get(row) ?? null);
      const dimensionEquivalent = dimensionEquivalentValues.every((value) => value !== null)
        ? dimensionEquivalentValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
        : null;
      const dimensionExact = entries.filter(({ tokenAttributionQuality, modelAttributionQuality, effortAttributionQuality }) =>
        tokenAttributionQuality === "exact" && modelAttributionQuality === "exact" && effortAttributionQuality === "exact"
      ).length;
      const dimensionContributors = new Set(entries.map(({ userId }) => userId)).size;
      await env.DB.prepare(
        `insert into subscription_dimension_aggregate
          (id, plan_id, period, reported_model, reasoning_effort, query_source, contributor_count,
           usage_slice_count, exact_slice_count, observed_token_total, api_equivalent_micros, snapshot_day, calculated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(plan_id, period, reported_model, reasoning_effort, query_source, snapshot_day) do update set
           contributor_count=excluded.contributor_count, usage_slice_count=excluded.usage_slice_count,
           exact_slice_count=excluded.exact_slice_count, observed_token_total=excluded.observed_token_total,
           api_equivalent_micros=excluded.api_equivalent_micros, calculated_at=excluded.calculated_at`
      ).bind(
        crypto.randomUUID(), plan.id, period, model, reasoningEffort, querySource,
        dimensionContributors, entries.length, dimensionExact, dimensionTokens,
        dimensionEquivalent, snapshotDay, now
      ).run();
      if (dimensionContributors >= PRIVACY_MINIMUM_CONTRIBUTORS) {
        modelMix.push({
          model, reasoningEffort, querySource, contributorCount: dimensionContributors,
          usageSliceCount: entries.length, exactSlicePercent: round(dimensionExact / entries.length * 100),
          observedTokens: dimensionTokens,
          sharePercent: totals.observed === 0 ? 0 : round(dimensionTokens / totals.observed * 100),
          apiEquivalentMicros: dimensionEquivalent
        });
      }
    }

    // Plans remain visible as Pending, but no contributor-derived measurements
    // are exposed until the k-anonymity threshold is met.
    const eligible = contributors.size >= PRIVACY_MINIMUM_CONTRIBUTORS;
    publicItems.push({
      ...plan,
      contributorCount: eligible ? contributors.size : 0,
      subscriptionCount: eligible ? subscriptions.size : 0,
      usageSliceCount: eligible ? rows.length : 0,
      completeWindowCount: eligible ? completeWindows.get(plan.id) ?? 0 : 0,
      observedTokens: eligible ? totals.observed : 0,
      medianTokensPerSubscription: eligible ? median([...perSubscription.values()]) : null,
      apiEquivalentMicros: eligible ? reliableEquivalent : null,
      allowanceValueScore: eligible ? allowanceValueScore : null,
      satisfactionScore: eligible ? publicSatisfactionScore : null,
      satisfactionCount: eligible && satisfactionContributorCount >= PRIVACY_MINIMUM_CONTRIBUTORS ? satisfactionContributorCount : 0,
      qualityAdjustedValueScore: eligible ? qualityAdjustedValueScore : null,
      confidence: eligible ? confidence : 0,
      exactSlicePercent: eligible ? round(exactPercent) : 0,
      changePercent: eligible ? changePercent : null,
      methodologyVersion: METHODOLOGY_VERSION,
      modelMix: eligible ? modelMix.sort((a, b) => b.observedTokens - a.observedTokens) : []
    });
  }

  publicItems.sort((left, right) =>
    (right.qualityAdjustedValueScore ?? -1) - (left.qualityAdjustedValueScore ?? -1) ||
    right.confidence - left.confidence || left.name.localeCompare(right.name)
  );
  return {
    schemaVersion: SUBSCRIPTION_SCHEMA_VERSION,
    period,
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 20 * 60_000).toISOString(),
    privacyMinimumContributors: PRIVACY_MINIMUM_CONTRIBUTORS,
    items: publicItems
  };
};

export const subscriptionRankingCacheKey = (period: SubscriptionPeriod): string =>
  `subscription-rankings:${period}:v${SUBSCRIPTION_SCHEMA_VERSION}`;

export const recalculateSubscriptionRankings = async (env: Env, now = Date.now()): Promise<void> => {
  for (const period of PERIODS) {
    const payload = await buildPeriod(env, period, now);
    await env.PUBLIC_CACHE.put(subscriptionRankingCacheKey(period), JSON.stringify(payload), { expirationTtl: 30 * 60 });
  }
};

const loadStoredSubscriptionRanking = async (
  env: Env,
  period: SubscriptionPeriod,
  now: number
): Promise<PublicSubscriptionRankingPayload> => {
  const [planResult, aggregateResult, dimensionResult] = await Promise.all([
    env.DB.prepare(
      `select id, slug, provider_name as providerName, name, billing_period as billingPeriod,
              price_micros as priceMicros, currency, official_url as officialUrl,
              terms_version as termsVersion, terms_last_verified_at as termsLastVerifiedAt
       from subscription_plan where is_active = 1 order by provider_name, name`
    ).all<PlanRow>(),
    env.DB.prepare(
      `select plan_id as planId, contributor_count as contributorCount,
              subscription_count as subscriptionCount, usage_slice_count as usageSliceCount,
              complete_window_count as completeWindowCount, observed_token_total as observedTokens,
              median_tokens_per_subscription as medianTokensPerSubscription,
              api_equivalent_micros as apiEquivalentMicros,
              allowance_value_score as allowanceValueScore, satisfaction_score as satisfactionScore,
              satisfaction_count as satisfactionCount,
              quality_adjusted_value_score as qualityAdjustedValueScore, confidence,
              exact_slice_count as exactSliceCount, change_percent as changePercent,
              methodology_version as methodologyVersion, calculated_at as calculatedAt,
              snapshot_day as snapshotDay
       from subscription_aggregate
       where period = ? and snapshot_day = (
         select max(snapshot_day) from subscription_aggregate where period = ?
       )`
    ).bind(period, period).all<StoredAggregateRow>(),
    env.DB.prepare(
      `select plan_id as planId, reported_model as reportedModel,
              reasoning_effort as reasoningEffort, query_source as querySource,
              contributor_count as contributorCount, usage_slice_count as usageSliceCount,
              exact_slice_count as exactSliceCount, observed_token_total as observedTokens,
              api_equivalent_micros as apiEquivalentMicros
       from subscription_dimension_aggregate
       where period = ? and snapshot_day = (
         select max(snapshot_day) from subscription_aggregate where period = ?
       )`
    ).bind(period, period).all<StoredDimensionRow>()
  ]);
  const aggregates = new Map(aggregateResult.results.map((row) => [row.planId, row]));
  const dimensions = new Map<string, StoredDimensionRow[]>();
  for (const row of dimensionResult.results) {
    const rows = dimensions.get(row.planId) ?? [];
    rows.push(row);
    dimensions.set(row.planId, rows);
  }
  const items = planResult.results.map<SubscriptionRankingItem>((plan) => {
    const aggregate = aggregates.get(plan.id);
    const eligible = Boolean(aggregate && aggregate.contributorCount >= PRIVACY_MINIMUM_CONTRIBUTORS);
    const exactSlicePercent = aggregate && aggregate.usageSliceCount > 0
      ? round(aggregate.exactSliceCount / aggregate.usageSliceCount * 100)
      : 0;
    const modelMix = eligible ? (dimensions.get(plan.id) ?? [])
      .filter((row) => row.contributorCount >= PRIVACY_MINIMUM_CONTRIBUTORS)
      .map<SubscriptionModelMix>((row) => ({
      model: row.reportedModel,
      reasoningEffort: row.reasoningEffort,
      querySource: row.querySource,
      contributorCount: row.contributorCount,
      usageSliceCount: row.usageSliceCount,
      exactSlicePercent: row.usageSliceCount === 0 ? 0 : round(row.exactSliceCount / row.usageSliceCount * 100),
      observedTokens: row.observedTokens,
      sharePercent: aggregate?.observedTokens ? round(row.observedTokens / aggregate.observedTokens * 100) : 0,
      apiEquivalentMicros: row.apiEquivalentMicros
      })).sort((left, right) => right.observedTokens - left.observedTokens) : [];
    return {
      ...plan,
      contributorCount: eligible ? aggregate!.contributorCount : 0,
      subscriptionCount: eligible ? aggregate!.subscriptionCount : 0,
      usageSliceCount: eligible ? aggregate!.usageSliceCount : 0,
      completeWindowCount: eligible ? aggregate!.completeWindowCount : 0,
      observedTokens: eligible ? aggregate!.observedTokens : 0,
      medianTokensPerSubscription: eligible ? aggregate!.medianTokensPerSubscription : null,
      apiEquivalentMicros: eligible ? aggregate!.apiEquivalentMicros : null,
      allowanceValueScore: eligible ? aggregate!.allowanceValueScore : null,
      satisfactionScore: eligible && aggregate!.satisfactionCount >= PRIVACY_MINIMUM_CONTRIBUTORS ? aggregate!.satisfactionScore : null,
      satisfactionCount: eligible && aggregate!.satisfactionCount >= PRIVACY_MINIMUM_CONTRIBUTORS ? aggregate!.satisfactionCount : 0,
      qualityAdjustedValueScore: eligible ? aggregate!.qualityAdjustedValueScore : null,
      confidence: eligible ? aggregate!.confidence : 0,
      exactSlicePercent: eligible ? exactSlicePercent : 0,
      changePercent: eligible ? aggregate!.changePercent : null,
      methodologyVersion: aggregate?.methodologyVersion ?? METHODOLOGY_VERSION,
      modelMix
    };
  });
  items.sort((left, right) =>
    (right.qualityAdjustedValueScore ?? -1) - (left.qualityAdjustedValueScore ?? -1) ||
    right.confidence - left.confidence || left.name.localeCompare(right.name)
  );
  const lastCalculatedAt = aggregateResult.results.reduce((latest, row) => Math.max(latest, row.calculatedAt), 0);
  const generatedAt = lastCalculatedAt || now;
  return {
    schemaVersion: SUBSCRIPTION_SCHEMA_VERSION,
    period,
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    privacyMinimumContributors: PRIVACY_MINIMUM_CONTRIBUTORS,
    items
  };
};

export const loadSubscriptionRanking = async (
  env: Env,
  period: SubscriptionPeriod,
  now = Date.now()
): Promise<PublicSubscriptionRankingPayload> => {
  const cached = await env.PUBLIC_CACHE.get(subscriptionRankingCacheKey(period), "json").catch(() => null) as PublicSubscriptionRankingPayload | null;
  if (cached?.schemaVersion === SUBSCRIPTION_SCHEMA_VERSION && cached.period === period && Date.parse(cached.expiresAt) > now) return cached;
  // Public GETs never aggregate raw user telemetry or write snapshots. The
  // scheduler is the sole aggregation writer; this is a read-only D1 fallback.
  return loadStoredSubscriptionRanking(env, period, now);
};
