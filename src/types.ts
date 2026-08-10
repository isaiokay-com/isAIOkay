export const CURRENT_SCHEMA_VERSION = 8 as const;

export type ItemType = "model" | "agent";
export type Period = "live" | "24h" | "7d";
export type AggregatePeriod = Period | "release_baseline";
export type ModerationStatus = "pending" | "approved" | "excluded";
export type TrustCategory = "blocked" | "probation" | "normal" | "trusted";
export type UserStatus = "active" | "suspended" | "admin" | "deleted";
export type AggregateState = "new" | "steady" | "improving" | "degrading";

export interface FeedbackAllowance {
  remaining: 0 | 1 | 2;
  nextAvailableAt: string | null;
  alreadyRatedItemIds: string[];
}

export interface RankingItem {
  id: string;
  name: string;
  slug: string;
  providerName: string;
  type: ItemType;
  description: string | null;
  logoUrl: string | null;
  officialUrl: string | null;
  pricingSummary: string | null;
  pricingLastVerifiedAt: number | null;
  versionLabel: string | null;
  releaseAt: number | null;
  releaseSourceUrl: string | null;
  overallScore: number;
  resultQualityScore: number;
  usageEfficiencyScore: number;
  confidence: number;
  reportCount: number;
  developerCount: number;
  rankChange: number | null;
  change: number;
  resultQualityChangeVsPrevious: number;
  releaseBaselineResultQuality: number | null;
  resultQualityChangeSinceRelease: number | null;
  baselineEvidenceStatus: "no_release_baseline" | "collecting" | "insufficient_evidence" | "available";
  possibleDegradationSinceRelease: boolean;
  state: AggregateState;
  calculatedAt: number;
  positiveTags: string[];
  complaintTags: string[];
  trend: Array<{ at: number; score: number }>;
  agentContexts: Array<{
    agentId: string;
    agentName: string;
    overallScore: number;
    reportCount: number;
    developerCount: number;
  }>;
}

export interface PublicRankingPayload {
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  period: Period;
  generatedAt: string;
  expiresAt: string;
  items: RankingItem[];
  totalReports: number;
}

export interface ModelHistoryPoint {
  at: number;
  overallScore: number;
  resultQualityScore: number;
  usageEfficiencyScore: number;
  confidence: number;
  reportCount: number;
}

export interface ModelPageHistory {
  addedAt: number;
  updatedAt: number;
  points: ModelHistoryPoint[];
}

export interface ModelSitemapEntry {
  providerName: string;
  slug: string;
  versionLabel: string | null;
  updatedAt: number;
}

export interface CatalogProviderFeed {
  provider: string;
  url: string;
}

export interface AppSettings {
  minAccountAgeDays: number;
  probationAccountAgeDays: number;
  lowConfidenceReportThreshold: number;
  requireTurnstileForProbation: boolean;
  requireTurnstileForSuspicious: boolean;
  bayesianPriorScore: number;
  bayesianPriorWeight: number;
  liveScoreHalfLifeDays: number;
  liveScoreLookbackDays: number;
  degradingThreshold: number;
  possibleDegradationMinimumConfidence: number;
  releaseBaselineMinReports: number;
  releaseBaselineMinUniqueReporters: number;
  releaseBaselineMinSpanDays: number;
  releaseBaselineMinConfidence: number;
  releaseDegradationThreshold: number;
  improvingThreshold: number;
  riskRetentionDays: number;
  /** Master switch for automated catalog discovery. Off by default. */
  catalogDiscoveryEnabled: boolean;
  /** Authoritative, admin-verified provider release feeds. */
  catalogProviderFeeds: CatalogProviderFeed[];
  /** Social sources are optional, nomination-only, and never affect scores. */
  catalogSocialDiscoveryEnabled: boolean;
  catalogRedditFeedUrl: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  minAccountAgeDays: 7,
  probationAccountAgeDays: 30,
  lowConfidenceReportThreshold: 8,
  requireTurnstileForProbation: true,
  requireTurnstileForSuspicious: true,
  bayesianPriorScore: 60,
  bayesianPriorWeight: 6,
  liveScoreHalfLifeDays: 14,
  liveScoreLookbackDays: 180,
  degradingThreshold: -4,
  possibleDegradationMinimumConfidence: 35,
  releaseBaselineMinReports: 20,
  releaseBaselineMinUniqueReporters: 15,
  releaseBaselineMinSpanDays: 3,
  releaseBaselineMinConfidence: 65,
  releaseDegradationThreshold: -8,
  improvingThreshold: 4,
  riskRetentionDays: 30,
  catalogDiscoveryEnabled: false,
  catalogProviderFeeds: [],
  catalogSocialDiscoveryEnabled: false,
  catalogRedditFeedUrl: ""
};
