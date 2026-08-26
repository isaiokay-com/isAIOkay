import type { APIRoute } from "astro";
import { getClientKey, json, toErrorResponse } from "../../lib/http";
import { enforceNamedRateLimit } from "../../lib/rate-limit";
import { getRuntimeEnv } from "../../lib/runtime";
import { loadSubscriptionRanking } from "../../services/subscription-aggregation";
import type { SubscriptionPeriod } from "../../types";

export const prerender = false;

const parsePeriod = (request: Request): SubscriptionPeriod => {
  const value = new URL(request.url).searchParams.get("period");
  return value === "30d" || value === "90d" ? value : "7d";
};

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", `subscription-ranking:${getClientKey(context.request)}`);
    const payload = await loadSubscriptionRanking(env, parsePeriod(context.request));
    return json(payload, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (error) {
    return toErrorResponse(error);
  }
};
