import { describe, expect, it } from "vitest";
import { compareRecommendedRanking, developerEvidenceScore, recommendedRankingValue } from "../../src/lib/ranking";

describe("live ranking", () => {
  it("rewards independent developer breadth when recent confidence exists", () => {
    expect(developerEvidenceScore(20, 60)).toBeGreaterThan(developerEvidenceScore(1, 60));
  });

  it("does not let an old developer count survive without current evidence", () => {
    expect(developerEvidenceScore(1000, 0)).toBe(0);
  });

  it("balances developer experience, confidence, breadth, and regression risk", () => {
    const narrow = recommendedRankingValue({ overallScore: 78, confidence: 45, developerCount: 2, possibleDegradationSinceRelease: false });
    const broad = recommendedRankingValue({ overallScore: 78, confidence: 45, developerCount: 30, possibleDegradationSinceRelease: false });
    const regressing = recommendedRankingValue({ overallScore: 78, confidence: 45, developerCount: 30, possibleDegradationSinceRelease: true });
    expect(broad).toBeGreaterThan(narrow);
    expect(regressing).toBeLessThan(broad);
  });

  it("uses the same ordering comparator for assembled rankings", () => {
    const narrow = { name: "Narrow", overallScore: 78, confidence: 45, developerCount: 2, possibleDegradationSinceRelease: false };
    const broad = { name: "Broad", overallScore: 78, confidence: 45, developerCount: 30, possibleDegradationSinceRelease: false };
    expect([narrow, broad].sort(compareRecommendedRanking).map((item) => item.name)).toEqual(["Broad", "Narrow"]);
  });
});
