import { describe, expect, it } from "vitest";
import { cliFeedbackInputSchema, normalizeModelLabel, toolFallbackSlug } from "../../src/lib/cli";
import { deriveCliAttribution } from "../../src/services/cli-feedback";
import type { CliFeedbackInput } from "../../src/lib/cli";

const feedbackInput = (overrides: Partial<CliFeedbackInput>): CliFeedbackInput => ({
  tool: "codex",
  rawModelLabel: "gpt-5.6",
  attribution: "verified_active",
  adapterVersion: "1.0.0",
  sessionHash: "a".repeat(64),
  sessionDurationBucket: "10_30m",
  resultQualityRating: 4,
  usageEfficiencyRating: 4,
  tags: [],
  clientEventId: crypto.randomUUID(),
  ...overrides
});

describe("CLI feedback contracts", () => {
  it("normalizes provider model labels without retaining arbitrary text", () => {
    expect(normalizeModelLabel("  OpenAI/GPT-5.6 Codex (High) ")).toBe("openai-gpt-5-6-codex-high");
  });

  it("requires a privacy-safe HMAC session identifier", () => {
    const base = {
      tool: "opencode",
      rawModelLabel: "anthropic/claude-sonnet",
      attribution: "verified_active",
      adapterVersion: "1.0.0",
      sessionDurationBucket: "10_30m",
      resultQualityRating: 2,
      usageEfficiencyRating: 3,
      tags: ["instruction-following"],
      clientEventId: crypto.randomUUID()
    };
    expect(cliFeedbackInputSchema.safeParse({ ...base, sessionHash: "a".repeat(64) }).success).toBe(true);
    expect(cliFeedbackInputSchema.safeParse({ ...base, sessionHash: "raw-session-id" }).success).toBe(false);
  });

  it("maps opaque routing only to the coding tool", () => {
    expect(toolFallbackSlug("cursor")).toBe("cursor");
    expect(toolFallbackSlug("copilot-cli")).toBe("github-copilot-cli");
    expect(toolFallbackSlug("grok-build")).toBe("grok-build");
    expect(toolFallbackSlug("qwen-code")).toBe("qwen-code");
    expect(toolFallbackSlug("kimi-code")).toBe("kimi-code");
    expect(toolFallbackSlug("muse-code")).toBe("muse-code");
    expect(toolFallbackSlug("other")).toBeNull();
  });

  it("derives attribution strength from the tool instead of trusting the client", () => {
    expect(deriveCliAttribution(feedbackInput({ tool: "claude-code", attribution: "verified_active" }))).toBe("verified_start_only");
    expect(deriveCliAttribution(feedbackInput({ tool: "cursor", attribution: "verified_active" }))).toBe("model_at_end");
    expect(deriveCliAttribution(feedbackInput({ tool: "copilot-cli", attribution: "verified_active" }))).toBe("unknown");
    expect(deriveCliAttribution(feedbackInput({ tool: "grok-build", attribution: "verified_active" }))).toBe("unknown");
    expect(deriveCliAttribution(feedbackInput({ tool: "qwen-code", attribution: "verified_active" }))).toBe("verified_start_only");
    expect(deriveCliAttribution(feedbackInput({ tool: "kimi-code", attribution: "verified_active" }))).toBe("verified_start_only");
    expect(deriveCliAttribution(feedbackInput({ tool: "muse-code", attribution: "verified_active" }))).toBe("unknown");
    expect(deriveCliAttribution(feedbackInput({ tool: "codex", attribution: "mixed" }))).toBe("mixed");
    expect(deriveCliAttribution(feedbackInput({ tool: "claude-code", confirmedItemSlug: "claude-opus-5" }))).toBe("user_confirmed");
  });
});
