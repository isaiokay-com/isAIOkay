import { z } from "zod";
import { DEFAULT_SETTINGS } from "../types";
import { httpsUrlSchema } from "./security";

export const appSettingsSchema = z.object({
  minAccountAgeDays: z.number().int().min(1).max(365),
  probationAccountAgeDays: z.number().int().min(1).max(365),
  lowConfidenceReportThreshold: z.number().int().min(1).max(100),
  requireTurnstileForProbation: z.boolean(),
  requireTurnstileForSuspicious: z.boolean(),
  bayesianPriorScore: z.number().min(0).max(100),
  bayesianPriorWeight: z.number().min(0.1).max(100),
  liveScoreHalfLifeDays: z.number().min(1).max(90),
  liveScoreLookbackDays: z.number().int().min(30).max(730),
  degradingThreshold: z.number().min(-100).max(0),
  possibleDegradationMinimumConfidence: z.number().min(0).max(100),
  releaseBaselineMinReports: z.number().int().min(1).max(1000),
  releaseBaselineMinUniqueReporters: z.number().int().min(1).max(1000),
  releaseBaselineMinSpanDays: z.number().min(0).max(7),
  releaseBaselineMinConfidence: z.number().min(0).max(100),
  releaseDegradationThreshold: z.number().min(-100).max(0),
  improvingThreshold: z.number().min(0).max(100),
  riskRetentionDays: z.number().int().min(1).max(365),
  catalogDiscoveryEnabled: z.boolean(),
  catalogProviderFeeds: z.array(z.object({
    provider: z.string().trim().min(1).max(80),
    url: httpsUrlSchema
  }).strict()).max(10).default([]),
  catalogSocialDiscoveryEnabled: z.boolean(),
  catalogRedditFeedUrl: httpsUrlSchema.or(z.literal("")).default("")
}).strict();

export const parseAppSettings = (value: unknown) => appSettingsSchema.parse({
  ...DEFAULT_SETTINGS,
  ...(typeof value === "object" && value !== null && !Array.isArray(value) ? value : {})
});
