import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_MIN_DEVELOPERS, AGENT_CONTEXT_MIN_REPORTS, summarizeAgentContexts, type AgentContextReport } from "../../src/lib/agent-context";
import { DEFAULT_SETTINGS } from "../../src/types";

const report = (index: number): AgentContextReport => ({
  agentId: "cursor",
  agentName: "Cursor",
  userId: `user-${index % AGENT_CONTEXT_MIN_DEVELOPERS}`,
  submittedAt: 1_800_000_000_000,
  resultQualityRating: 4,
  usageEfficiencyRating: 4,
  trustWeight: 1,
  fraudRiskScore: 0,
  moderationStatus: "approved",
  includedInScores: true,
  duplicateClusterAdjustment: 1
});

describe("agent context summaries", () => {
  it("suppresses slices below the public evidence thresholds", () => {
    expect(summarizeAgentContexts(Array.from({ length: AGENT_CONTEXT_MIN_REPORTS - 1 }, (_, index) => report(index)), 1_800_000_000_000, DEFAULT_SETTINGS, true)).toEqual([]);
  });

  it("publishes a contextual score after both thresholds are met", () => {
    const result = summarizeAgentContexts(Array.from({ length: AGENT_CONTEXT_MIN_REPORTS }, (_, index) => report(index)), 1_800_000_000_000, DEFAULT_SETTINGS, true);
    expect(result).toMatchObject([{ agentName: "Cursor", reportCount: AGENT_CONTEXT_MIN_REPORTS, developerCount: AGENT_CONTEXT_MIN_DEVELOPERS }]);
  });
});
