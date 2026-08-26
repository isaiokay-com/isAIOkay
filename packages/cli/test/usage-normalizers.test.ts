import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProviderQuota, normalizeProviderUsage } from "../src/usage-normalizers.js";

const subscriptionId = "10000000-0000-4000-8000-000000000001";
const secret = "s".repeat(64);

test("Claude usage keeps model, effort, cache, tier, and subagent attribution", () => {
  const [slice] = normalizeProviderUsage("claude", {
    sessionId: "private-session", requestId: "request-1", model: "claude-opus-4-8", effort: "xhigh",
    querySource: "subagent", serviceTier: "priority", timestamp: "2026-08-25T00:00:00Z",
    usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20, output_tokens: 40 }
  }, subscriptionId, secret, 1_800_000_000_000);
  assert.ok(slice);
  assert.equal(slice.reportedModel, "claude-opus-4-8");
  assert.equal(slice.reasoningEffort, "xhigh");
  assert.equal(slice.querySource, "subagent");
  assert.equal(slice.cacheReadTokens, 80);
  assert.notEqual(slice.sessionHash, "private-session");
});

test("Grok splits one session summary across every reported model", () => {
  const slices = normalizeProviderUsage("grok", {
    sessionId: "session", requestId: "turn", reasoningEffort: "high",
    usage: { modelUsage: {
      "grok-4.6-build": { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      "grok-4.6-mini": { inputTokens: 30, outputTokens: 5, totalTokens: 35 }
    } }
  }, subscriptionId, secret);
  assert.deepEqual(slices.map(({ reportedModel }) => reportedModel).sort(), ["grok-4.6-build", "grok-4.6-mini"]);
  assert.notEqual(slices[0]?.requestHash, slices[1]?.requestHash);
  assert.ok(slices.every(({ granularity }) => granularity === "session_model"));
});

test("quota snapshots preserve separate reset scopes", () => {
  const snapshots = normalizeProviderQuota("codex", {
    timestamp: "2026-08-25T00:00:00Z",
    rateLimits: {
      primary: { used_percent: 25, resets_at: 1_800_000_000 },
      secondary: { used_percent: 70, resets_at: 1_800_100_000 }
    }
  }, subscriptionId);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0]?.usedPercent, 25);
  assert.equal(snapshots[0]?.resetAt, 1_800_000_000_000);
});

test("quota snapshots preserve fractional percentages", () => {
  const [snapshot] = normalizeProviderQuota("codex", {
    timestamp: "2026-08-25T00:00:00Z",
    rateLimits: { weekly: { used_percent: 25.5, remaining_percent: 74.5 } }
  }, subscriptionId);
  assert.equal(snapshot?.usedPercent, 25.5);
  assert.equal(snapshot?.remainingPercent, 74.5);
});
