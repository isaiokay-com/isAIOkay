import type { APIRoute } from "astro";
import { getClientKey, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireCliIdentity } from "../../../services/cli-auth";

export const prerender = false;

type UsagePeriod = "7d" | "30d" | "90d" | "all";
const PERIOD_MS: Record<Exclude<UsagePeriod, "all">, number> = {
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  "90d": 90 * 86_400_000
};

interface UsageSummaryRow {
  clientSubscriptionId: string;
  planLabel: string;
  providerName: string;
  reportedModel: string;
  reasoningEffort: string;
  querySource: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  observedTokens: number;
  usageSliceCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
}

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", `cli-usage:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "usage:read");
    const requested = new URL(context.request.url).searchParams.get("period");
    const period: UsagePeriod = requested === "7d" || requested === "30d" || requested === "90d" || requested === "all" ? requested : "30d";
    const since = period === "all" ? null : Date.now() - PERIOD_MS[period];
    const rows = await env.DB.prepare(
      `select us.client_subscription_id as clientSubscriptionId, us.plan_label as planLabel,
              us.provider_name as providerName, u.reported_model as reportedModel,
              coalesce(u.reasoning_effort, 'default/unknown') as reasoningEffort,
              u.query_source as querySource, sum(u.input_tokens) as inputTokens,
              sum(u.cache_read_tokens) as cacheReadTokens,
              sum(u.cache_write_tokens) as cacheWriteTokens,
              sum(u.output_tokens) as outputTokens, sum(u.reasoning_tokens) as reasoningTokens,
              sum(coalesce(u.reported_total_tokens,
                u.input_tokens + u.output_tokens + case when u.tool = 'claude-code'
                  then u.cache_read_tokens + u.cache_write_tokens else 0 end)) as observedTokens,
              count(*) as usageSliceCount, min(u.observed_at) as firstObservedAt,
              max(u.observed_at) as lastObservedAt
       from usage_slice u join user_subscription us on us.id = u.subscription_id
       where u.user_id = ? and (? is null or u.observed_at >= ?)
       group by us.id, u.reported_model, coalesce(u.reasoning_effort, 'default/unknown'), u.query_source
       order by observedTokens desc limit 1000`
    ).bind(identity.userId, since, since).all<UsageSummaryRow>();
    return json({ period, generatedAt: new Date().toISOString(), rows: rows.results });
  } catch (error) {
    return toErrorResponse(error);
  }
};
