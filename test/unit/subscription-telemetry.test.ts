import { describe, expect, it } from "vitest";
import { quotaSnapshotInputSchema, subscriptionInputSchema, telemetryBatchSchema, usageSliceInputSchema } from "../../src/lib/telemetry";

const id = () => crypto.randomUUID();

describe("subscription telemetry schemas", () => {
  it("accepts model-and-effort attributed usage without content fields", () => {
    const usage = usageSliceInputSchema.parse({
      clientEventId: id(),
      clientSubscriptionId: id(),
      tool: "claude-code",
      sessionHash: "a".repeat(43),
      requestHash: "b".repeat(43),
      reportedModel: "claude-opus-4-8",
      reasoningEffort: "xhigh",
      querySource: "subagent",
      granularity: "request",
      attributionQuality: "exact",
      inputTokens: 100,
      cacheReadTokens: 80,
      outputTokens: 20,
      reasoningTokens: 10,
      observedAt: Date.now(),
      collectorVersion: "0.3.0"
    });
    expect(usage).toMatchObject({ reportedModel: "claude-opus-4-8", reasoningEffort: "xhigh", querySource: "subagent" });
  });

  it("rejects payload smuggling and empty observations", () => {
    const base = {
      clientEventId: id(), clientSubscriptionId: id(), tool: "codex", reportedModel: "gpt-5.6-sol",
      granularity: "turn", attributionQuality: "exact", observedAt: Date.now(), collectorVersion: "0.3.0"
    };
    expect(() => usageSliceInputSchema.parse({ ...base, prompt: "private", outputTokens: 1 })).toThrow();
    expect(() => usageSliceInputSchema.parse(base)).toThrow();
    expect(() => telemetryBatchSchema.parse({ usage: [], quota: [] })).toThrow();
  });

  it("keeps community consent explicit and quota percentages bounded", () => {
    const subscription = subscriptionInputSchema.parse({
      clientSubscriptionId: id(), providerName: "Anthropic", planLabel: "Claude Max 5x"
    });
    expect(subscription.aggregateConsent).toBe(false);
    expect(() => quotaSnapshotInputSchema.parse({
      clientEventId: id(), clientSubscriptionId: id(), quotaScope: "weekly", windowKind: "weekly",
      usedPercent: 101, attributionQuality: "exact", observedAt: Date.now(), collectorVersion: "0.3.0"
    })).toThrow();
  });
});
