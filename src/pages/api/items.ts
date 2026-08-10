import type { APIRoute } from "astro";
import { loadPublicRanking } from "../../lib/cache";
import { getRuntimeEnv } from "../../lib/runtime";
import { json, toErrorResponse } from "../../lib/http";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  try {
    const requestedPeriod = new URL(context.request.url).searchParams.get("period");
    const period = requestedPeriod === "24h" || requestedPeriod === "7d" ? requestedPeriod : "live";
    const result = await loadPublicRanking(getRuntimeEnv(context.locals), period);
    return json(result.payload, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (error) {
    return toErrorResponse(error);
  }
};
