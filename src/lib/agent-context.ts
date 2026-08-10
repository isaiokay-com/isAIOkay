import { calculateScores, isEligibleScoreReport } from "./scoring";
import type { AppSettings, RankingItem } from "../types";

export const AGENT_CONTEXT_MIN_REPORTS = 5;
export const AGENT_CONTEXT_MIN_DEVELOPERS = 3;

export interface AgentContextReport {
  agentId: string;
  agentName: string;
  userId: string;
  submittedAt: number;
  resultQualityRating: number;
  usageEfficiencyRating: number;
  trustWeight: number;
  fraudRiskScore: number;
  moderationStatus: "pending" | "approved" | "excluded";
  includedInScores: boolean;
  duplicateClusterAdjustment: number;
}

export const summarizeAgentContexts = (
  reports: AgentContextReport[],
  now: number,
  settings: AppSettings,
  live: boolean
): RankingItem["agentContexts"] => {
  const grouped = new Map<string, AgentContextReport[]>();
  for (const report of reports) {
    if (!isEligibleScoreReport(report)) continue;
    const group = grouped.get(report.agentId) ?? [];
    group.push(report);
    grouped.set(report.agentId, group);
  }

  return [...grouped.entries()].flatMap(([agentId, group]) => {
    const developerCount = new Set(group.map((report) => report.userId)).size;
    if (group.length < AGENT_CONTEXT_MIN_REPORTS || developerCount < AGENT_CONTEXT_MIN_DEVELOPERS) return [];
    const scores = calculateScores(group, now, settings, live
      ? { recencyMode: "live", liveHalfLifeDays: settings.liveScoreHalfLifeDays }
      : undefined);
    return [{
      agentId,
      agentName: group[0]!.agentName,
      overallScore: Math.round(scores.overallScore),
      reportCount: scores.reportCount,
      developerCount
    }];
  }).sort((left, right) => right.reportCount - left.reportCount || left.agentName.localeCompare(right.agentName));
};
