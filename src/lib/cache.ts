import type { Env } from "../env";
import { CURRENT_SCHEMA_VERSION, type Period, type PublicRankingPayload } from "../types";
import { getRankingFromD1 } from "../db/repositories";
import { httpsUrlSchema } from "./security";
import { z } from "zod";

export const PUBLIC_EDGE_CACHE_NAME = "isaiokay-public-v12";

const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const rankingItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  providerName: z.string(),
  type: z.enum(["model", "agent"]),
  description: z.string().nullable(),
  logoUrl: z.string().nullable(),
  officialUrl: httpsUrlSchema.nullable(),
  pricingSummary: z.string().nullable(),
  pricingLastVerifiedAt: z.number().nullable(),
  versionLabel: z.string().nullable(),
  releaseAt: z.number().nullable(),
  releaseSourceUrl: httpsUrlSchema.nullable(),
  overallScore: z.number(),
  resultQualityScore: z.number(),
  usageEfficiencyScore: z.number(),
  confidence: z.number(),
  reportCount: z.number(),
  developerCount: z.number().int().nonnegative(),
  rankChange: z.number().int().nullable(),
  change: z.number(),
  resultQualityChangeVsPrevious: z.number(),
  releaseBaselineResultQuality: z.number().nullable(),
  resultQualityChangeSinceRelease: z.number().nullable(),
  baselineEvidenceStatus: z.enum(["no_release_baseline", "collecting", "insufficient_evidence", "available"]),
  possibleDegradationSinceRelease: z.boolean(),
  state: z.enum(["new", "steady", "improving", "degrading"]),
  calculatedAt: z.number(),
  positiveTags: z.array(z.string()),
  complaintTags: z.array(z.string()),
  trend: z.array(z.object({ at: z.number(), score: z.number() })),
  agentContexts: z.array(z.object({
    agentId: z.string(),
    agentName: z.string(),
    overallScore: z.number().min(0).max(100),
    reportCount: z.number().int().nonnegative(),
    developerCount: z.number().int().nonnegative()
  }))
});
const publicRankingPayloadSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  period: z.enum(["live", "24h", "7d"]),
  generatedAt: timestampSchema,
  expiresAt: timestampSchema,
  items: z.array(rankingItemSchema),
  totalReports: z.number().int().nonnegative()
});

export const rankingCacheKey = (period: Period): string => `rankings:${period}:v${CURRENT_SCHEMA_VERSION}`;

export const isFreshPayload = (payload: PublicRankingPayload, now = Date.now()): boolean =>
  payload.schemaVersion === CURRENT_SCHEMA_VERSION && new Date(payload.expiresAt).getTime() > now;

export const readRankingCache = async (env: Env, period: Period): Promise<PublicRankingPayload | null> => {
  try {
    const cached = await env.PUBLIC_CACHE.get(rankingCacheKey(period), "json");
    const parsed = publicRankingPayloadSchema.safeParse(cached);
    return parsed.success && isFreshPayload(parsed.data) ? parsed.data : null;
  } catch (error) {
    console.warn("Public KV cache unavailable; using D1", error);
    return null;
  }
};

export const loadPublicRanking = async (env: Env, period: Period): Promise<{ payload: PublicRankingPayload; source: "kv" | "d1" }> => {
  const cached = await readRankingCache(env, period);
  if (cached) return { payload: cached, source: "kv" };
  return { payload: await getRankingFromD1(env, period), source: "d1" };
};

export const writePublicRanking = async (env: Env, period: Period, now = Date.now()): Promise<PublicRankingPayload> => {
  const payload = await getRankingFromD1(env, period, now);
  const ttlSeconds = Math.max(1, Math.floor((new Date(payload.expiresAt).getTime() - now) / 1000));
  await env.PUBLIC_CACHE.put(rankingCacheKey(period), JSON.stringify(payload), { expirationTtl: ttlSeconds });
  return payload;
};

export const regeneratePublicCache = async (env: Env, now = Date.now()): Promise<void> => {
  await Promise.all([writePublicRanking(env, "live", now), writePublicRanking(env, "24h", now), writePublicRanking(env, "7d", now)]);
  await env.PUBLIC_CACHE.put("public-config:v1", JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION, generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString() }), { expirationTtl: 600 });
};

export const invalidatePublicProfileEdgeCache = async (baseUrl: string, githubUsername: string): Promise<void> => {
  try {
    const cache = await caches.open(PUBLIC_EDGE_CACHE_NAME);
    const origin = new URL(baseUrl);
    await Promise.all([
      cache.delete(new Request(new URL(`/og/profile/${encodeURIComponent(githubUsername)}.png`, origin))),
      cache.delete(new Request(new URL("/sitemap.xml", origin)))
    ]);
  } catch (error) {
    console.warn("Public profile edge cache invalidation failed", error);
  }
};
