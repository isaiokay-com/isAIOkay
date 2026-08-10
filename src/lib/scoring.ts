import type { AggregateState, AppSettings } from "../types";

export const SCORE_WEIGHTS = {
  resultQuality: 0.7,
  usageEfficiency: 0.3
} as const;

export const normalizeRating = (rating: number): number => {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new RangeError("Ratings must be integers from 1 through 5");
  return (rating - 1) * 25;
};

export const recencyWeight = (ageMs: number): number => {
  if (ageMs < 0) return 1;
  if (ageMs <= 6 * 3_600_000) return 1;
  if (ageMs <= 24 * 3_600_000) return 0.85;
  if (ageMs <= 3 * 86_400_000) return 0.6;
  if (ageMs <= 7 * 86_400_000) return 0.35;
  return 0;
};

export const liveRecencyWeight = (ageMs: number, halfLifeDays: number): number => {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) throw new RangeError("Live half-life must be greater than zero");
  if (ageMs <= 0) return 1;
  return 2 ** (-(ageMs / 86_400_000) / halfLifeDays);
};

export interface ScoreReport {
  submittedAt: number;
  resultQualityRating: number;
  usageEfficiencyRating: number;
  trustWeight: number;
  fraudRiskScore: number;
  moderationStatus: "pending" | "approved" | "excluded";
  includedInScores: boolean;
  duplicateClusterAdjustment?: number;
}

export interface ScoredAggregate {
  reportCount: number;
  weightedReportCount: number;
  overallScore: number;
  resultQualityScore: number;
  usageEfficiencyScore: number;
  confidence: number;
}

export const isEligibleScoreReport = (report: ScoreReport): boolean =>
  report.includedInScores
  && report.moderationStatus !== "excluded"
  && report.trustWeight > 0
  && report.fraudRiskScore < 1
  && (report.duplicateClusterAdjustment ?? 1) > 0;

const stableScore = (sum: number, weight: number, priorScore: number, priorWeight: number): number =>
  (sum + priorScore * priorWeight) / (weight + priorWeight);

export const calculateScores = (
  reports: ScoreReport[],
  now: number,
  settings: Pick<AppSettings, "bayesianPriorScore" | "bayesianPriorWeight">,
  options: { recencyMode?: "window" | "live"; liveHalfLifeDays?: number } = {}
): ScoredAggregate => {
  let reportCount = 0;
  let weightTotal = 0;
  let resultQualitySum = 0;
  let usageEfficiencySum = 0;

  for (const report of reports) {
    if (!isEligibleScoreReport(report)) continue;
    const ageWeight = options.recencyMode === "live"
      ? liveRecencyWeight(now - report.submittedAt, options.liveHalfLifeDays ?? 14)
      : recencyWeight(now - report.submittedAt);
    const duplicateAdjustment = report.duplicateClusterAdjustment ?? 1;
    const weight = ageWeight * report.trustWeight * (1 - report.fraudRiskScore) * duplicateAdjustment;
    if (weight <= 0) continue;
    reportCount += 1;
    weightTotal += weight;
    resultQualitySum += normalizeRating(report.resultQualityRating) * weight;
    usageEfficiencySum += normalizeRating(report.usageEfficiencyRating) * weight;
  }

  const resultQualityScore = stableScore(resultQualitySum, weightTotal, settings.bayesianPriorScore, settings.bayesianPriorWeight);
  const usageEfficiencyScore = stableScore(usageEfficiencySum, weightTotal, settings.bayesianPriorScore, settings.bayesianPriorWeight);
  const overallScore = resultQualityScore * SCORE_WEIGHTS.resultQuality
    + usageEfficiencyScore * SCORE_WEIGHTS.usageEfficiency;

  return {
    reportCount,
    weightedReportCount: weightTotal,
    overallScore,
    resultQualityScore,
    usageEfficiencyScore,
    confidence: Math.max(0, Math.min(100, (weightTotal / (weightTotal + settings.bayesianPriorWeight)) * 100))
  };
};

export const aggregateState = (change: number, reportCount: number, confidence: number, settings: Pick<AppSettings, "lowConfidenceReportThreshold" | "improvingThreshold" | "degradingThreshold" | "possibleDegradationMinimumConfidence">): AggregateState => {
  if (reportCount < settings.lowConfidenceReportThreshold) return "new";
  if (change >= settings.improvingThreshold) return "improving";
  if (change <= settings.degradingThreshold && confidence >= settings.possibleDegradationMinimumConfidence) return "degrading";
  return "steady";
};

export const qualifiesReleaseBaseline = (
  evidence: { reportCount: number; uniqueReporters: number; spanDays: number; confidence: number },
  settings: Pick<AppSettings, "releaseBaselineMinReports" | "releaseBaselineMinUniqueReporters" | "releaseBaselineMinSpanDays" | "releaseBaselineMinConfidence">
): boolean =>
  evidence.reportCount >= settings.releaseBaselineMinReports
  && evidence.uniqueReporters >= settings.releaseBaselineMinUniqueReporters
  && evidence.spanDays >= settings.releaseBaselineMinSpanDays
  && evidence.confidence >= settings.releaseBaselineMinConfidence;
