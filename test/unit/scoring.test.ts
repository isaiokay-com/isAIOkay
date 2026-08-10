import { describe, expect, it } from "vitest";
import { aggregateState, calculateScores, isEligibleScoreReport, liveRecencyWeight, normalizeRating, qualifiesReleaseBaseline, recencyWeight } from "../../src/lib/scoring";
import { DEFAULT_SETTINGS } from "../../src/types";

describe("scoring", () => {
  it("normalizes the five-point scale", () => {
    expect([1, 2, 3, 4, 5].map(normalizeRating)).toEqual([0, 25, 50, 75, 100]);
  });

  it("uses the documented recency weights", () => {
    expect(recencyWeight(6 * 3_600_000)).toBe(1);
    expect(recencyWeight(7 * 3_600_000)).toBe(0.85);
    expect(recencyWeight(2 * 86_400_000)).toBe(0.6);
    expect(recencyWeight(5 * 86_400_000)).toBe(0.35);
    expect(recencyWeight(8 * 86_400_000)).toBe(0);
  });

  it("decays the live consensus smoothly without a calendar reset", () => {
    expect(liveRecencyWeight(0, 14)).toBe(1);
    expect(liveRecencyWeight(14 * 86_400_000, 14)).toBeCloseTo(0.5);
    expect(liveRecencyWeight(28 * 86_400_000, 14)).toBeCloseTo(0.25);
    expect(liveRecencyWeight(90 * 86_400_000, 14)).toBeGreaterThan(0);
  });

  it("keeps older evidence in live scoring after fixed windows exclude it", () => {
    const now = 4_000_000_000;
    const report = {
      submittedAt: now - 30 * 86_400_000,
      resultQualityRating: 5,
      usageEfficiencyRating: 5,
      trustWeight: 1,
      fraudRiskScore: 0,
      moderationStatus: "approved" as const,
      includedInScores: true
    };
    expect(calculateScores([report], now, DEFAULT_SETTINGS).reportCount).toBe(0);
    const live = calculateScores([report], now, DEFAULT_SETTINGS, { recencyMode: "live", liveHalfLifeDays: 14 });
    expect(live.reportCount).toBe(1);
    expect(live.overallScore).toBeGreaterThan(DEFAULT_SETTINGS.bayesianPriorScore);
  });

  it("stabilizes sparse reports with a Bayesian prior", () => {
    const now = 1_000_000_000;
    const result = calculateScores([{
      submittedAt: now,
      resultQualityRating: 5,
      usageEfficiencyRating: 5,
      trustWeight: 1,
      fraudRiskScore: 0,
      moderationStatus: "approved",
      includedInScores: true
    }], now, DEFAULT_SETTINGS);
    expect(result.overallScore).toBeGreaterThan(DEFAULT_SETTINGS.bayesianPriorScore);
    expect(result.overallScore).toBeLessThan(100);
    expect(result.confidence).toBeLessThan(20);
  });

  it("keeps result quality and usage efficiency independent before the transparent 70/30 summary", () => {
    const now = 1_000_000_000;
    const result = calculateScores([{
      submittedAt: now,
      resultQualityRating: 5,
      usageEfficiencyRating: 1,
      trustWeight: 1,
      fraudRiskScore: 0,
      moderationStatus: "approved",
      includedInScores: true
    }], now, { bayesianPriorScore: 60, bayesianPriorWeight: 0 });
    expect(result.resultQualityScore).toBe(100);
    expect(result.usageEfficiencyScore).toBe(0);
    expect(result.overallScore).toBe(70);
  });

  it("requires report evidence and confidence before possible degradation", () => {
    expect(aggregateState(-10, 2, 90, DEFAULT_SETTINGS)).toBe("new");
    expect(aggregateState(-10, 12, 20, DEFAULT_SETTINGS)).toBe("steady");
    expect(aggregateState(-10, 12, 60, DEFAULT_SETTINGS)).toBe("degrading");
  });

  it("never promotes a prior-only release window to a baseline", () => {
    expect(qualifiesReleaseBaseline({ reportCount: 0, uniqueReporters: 0, spanDays: 0, confidence: 0 }, DEFAULT_SETTINGS)).toBe(false);
    expect(qualifiesReleaseBaseline({
      reportCount: DEFAULT_SETTINGS.releaseBaselineMinReports,
      uniqueReporters: DEFAULT_SETTINGS.releaseBaselineMinUniqueReporters,
      spanDays: DEFAULT_SETTINGS.releaseBaselineMinSpanDays,
      confidence: DEFAULT_SETTINGS.releaseBaselineMinConfidence
    }, DEFAULT_SETTINGS)).toBe(true);
  });

  it("uses one eligibility rule for scoring and release evidence gates", () => {
    const base = {
      submittedAt: Date.now(),
      resultQualityRating: 4,
      usageEfficiencyRating: 4,
      trustWeight: 1,
      fraudRiskScore: 0,
      moderationStatus: "approved" as const,
      includedInScores: true,
      duplicateClusterAdjustment: 1
    };
    expect(isEligibleScoreReport(base)).toBe(true);
    expect(isEligibleScoreReport({ ...base, includedInScores: false })).toBe(false);
    expect(isEligibleScoreReport({ ...base, moderationStatus: "excluded" })).toBe(false);
    expect(isEligibleScoreReport({ ...base, trustWeight: 0 })).toBe(false);
    expect(isEligibleScoreReport({ ...base, fraudRiskScore: 1 })).toBe(false);
    expect(isEligibleScoreReport({ ...base, duplicateClusterAdjustment: 0 })).toBe(false);
  });
});
