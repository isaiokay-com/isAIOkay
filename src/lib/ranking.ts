import type { RankingItem } from "../types";

/**
 * Confidence captures recency-weighted evidence. Developer breadth rewards
 * independent participation but is gated by that confidence, so a large old
 * cohort cannot keep an inactive item artificially high.
 */
export const developerEvidenceScore = (developerCount: number, confidence: number): number => {
  const breadth = 100 * (1 - Math.exp(-Math.max(0, developerCount) / 12));
  return Math.sqrt(breadth * Math.max(0, Math.min(100, confidence)));
};

export const recommendedRankingValue = (
  item: Pick<RankingItem, "overallScore" | "confidence" | "developerCount" | "possibleDegradationSinceRelease">
): number => item.overallScore * 0.72
  + item.confidence * 0.18
  + developerEvidenceScore(item.developerCount, item.confidence) * 0.1
  - (item.possibleDegradationSinceRelease ? 15 : 0);

type RecommendedRankingItem = Pick<
  RankingItem,
  "name" | "overallScore" | "confidence" | "developerCount" | "possibleDegradationSinceRelease"
>;

/** One comparator for API payloads, SSR ordering, and reconstructed movement. */
export const compareRecommendedRanking = (left: RecommendedRankingItem, right: RecommendedRankingItem): number =>
  recommendedRankingValue(right) - recommendedRankingValue(left)
  || right.confidence - left.confidence
  || left.name.localeCompare(right.name);
