import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectLocalTelemetry } from "../src/collectors.js";
import type { LocalConfig } from "../src/types.js";

const subscriptionIds = {
  claude: "10000000-0000-4000-8000-000000000001",
  codex: "10000000-0000-4000-8000-000000000002",
  grok: "10000000-0000-4000-8000-000000000003"
};

const config: LocalConfig = {
  schemaVersion: 1,
  hmacSecret: "s".repeat(64),
  onboardingCompletedAt: 1,
  adapters: {},
  subscriptions: [],
  subscriptionBindings: subscriptionIds,
  shellIntegrations: []
};

const jsonl = (...values: unknown[]): string => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;

test("local collectors preserve request-level model and effort without retaining content", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-collectors-"));
  context.after(async () => rm(home, { recursive: true, force: true }));
  const now = Date.now();
  const claudeDir = join(home, ".claude", "projects", "fixture");
  const codexDir = join(home, ".codex", "sessions", "2026", "08");
  const grokDir = join(home, ".grok", "sessions", "fixture");
  await Promise.all([mkdir(claudeDir, { recursive: true }), mkdir(codexDir, { recursive: true }), mkdir(grokDir, { recursive: true })]);

  await writeFile(join(claudeDir, "session.jsonl"), jsonl({
    sessionId: "raw-claude-session", requestId: "raw-claude-request", timestamp: new Date(now).toISOString(),
    effort: "high", isSidechain: true,
    message: {
      role: "assistant", id: "message-1", model: "claude-opus-test", content: "must never be retained",
      usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10, output_tokens: 20, service_tier: "priority" }
    }
  }), "utf8");
  await writeFile(join(codexDir, "rollout.jsonl"), jsonl(
    { type: "session_meta", payload: { id: "raw-codex-session", cwd: "/private/repository" } },
    { type: "turn_context", payload: { turn_id: "raw-codex-turn", model: "gpt-5.6-sol", effort: "xhigh" } },
    { type: "event_msg", timestamp: new Date(now).toISOString(), payload: {
      type: "token_count", info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 12, total_tokens: 230 } },
      rate_limits: { weekly: { used_percent: 41, resets_at: Math.floor((now + 86_400_000) / 1_000), window_kind: "weekly" } }
    } }
  ), "utf8");
  await writeFile(join(grokDir, "chat_history.jsonl"), jsonl(
    { model_id: "grok-build-a", reasoning_effort: "low", content: "discard this" },
    { model_id: "grok-build-b", reasoning_effort: "high", content: "discard this too" }
  ), "utf8");
  await writeFile(join(grokDir, "updates.jsonl"), jsonl({
    timestamp: Math.floor(now / 1_000), params: {
      sessionId: "raw-grok-session", _meta: { eventId: "raw-grok-prompt" }, update: { usage: { modelUsage: {
        "grok-build-a": { inputTokens: 40, outputTokens: 10, totalTokens: 50 },
        "grok-build-b": { inputTokens: 20, outputTokens: 5, totalTokens: 25 }
      } } }
    }
  }), "utf8");

  const result = await collectLocalTelemetry(config, home, now);
  assert.equal(result.usage.length, 4);
  assert.equal(result.quota.length, 1);
  assert.deepEqual(result.usage.map((slice) => slice.reportedModel).sort(), [
    "claude-opus-test", "gpt-5.6-sol", "grok-build-a", "grok-build-b"
  ]);
  assert.equal(result.usage.find((slice) => slice.provider === "claude")?.querySource, "subagent");
  assert.equal(result.usage.find((slice) => slice.provider === "codex")?.reasoningTokens, 12);
  assert.equal(result.usage.find((slice) => slice.reportedModel === "grok-build-b")?.effortAttributionQuality, "exact");
  assert.equal(result.usage.find((slice) => slice.reportedModel === "grok-build-b")?.granularity, "session_model");
  assert.ok(result.usage.every((slice) => !JSON.stringify(slice).includes("raw-") && !JSON.stringify(slice).includes("discard")));
});

test("collectors remain empty when no subscription is bound", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-collectors-empty-"));
  context.after(async () => rm(home, { recursive: true, force: true }));
  const result = await collectLocalTelemetry({ ...config, subscriptionBindings: {} }, home);
  assert.deepEqual(result.usage, []);
  assert.deepEqual(result.quota, []);
  assert.ok(result.diagnostics.every((entry) => entry.configured === false));
});

test("Codex collector preserves multiple observations in one quota window", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-quota-window-"));
  context.after(async () => rm(home, { recursive: true, force: true }));
  const now = Date.now();
  const codexDir = join(home, ".codex", "sessions", "2026", "08");
  await mkdir(codexDir, { recursive: true });
  const resetAt = Math.floor((now + 86_400_000) / 1_000);
  await writeFile(join(codexDir, "rollout.jsonl"), jsonl(
    { type: "session_meta", payload: { id: "session" } },
    { type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test", effort: "high" } },
    { type: "event_msg", timestamp: new Date(now - 60_000).toISOString(), payload: {
      type: "token_count", info: { last_token_usage: { input_tokens: 1 } },
      rate_limits: { weekly: { used_percent: 2, resets_at: resetAt, window_kind: "weekly" } }
    } },
    { type: "turn_context", payload: { turn_id: "turn-2", model: "gpt-test", effort: "high" } },
    { type: "event_msg", timestamp: new Date(now).toISOString(), payload: {
      type: "token_count", info: { last_token_usage: { input_tokens: 1 } },
      rate_limits: { weekly: { used_percent: 98, resets_at: resetAt, window_kind: "weekly" } }
    } }
  ), "utf8");

  const result = await collectLocalTelemetry(config, home, now);
  assert.equal(result.quota.length, 2);
  assert.deepEqual(result.quota.map(({ usedPercent }) => usedPercent), [2, 98]);
  assert.equal(new Set(result.quota.map(({ resetAt: value }) => value)).size, 1);
});
