import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSession } from "../src/session-summary.js";
import type { Attribution, StoredEvent } from "../src/types.js";

const event = (index: number, model: string | null, attribution: Attribution): StoredEvent => ({
  schemaVersion: 1,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  provider: "cursor",
  attribution,
  model,
  sessionHash: "a".repeat(43),
  occurredAt: 1_700_000_000_000 + index,
  recordedAt: 1_700_000_000_000 + index
});

test("Cursor explicit-to-Auto transitions remain opaque", () => {
  const summary = summarizeSession([
    event(1, "claude-sonnet-5", "explicit_model"),
    event(2, null, "opaque_auto")
  ], "cursor");
  assert.equal(summary.model, null);
  assert.equal(summary.attributionEvent.attribution, "opaque_auto");
});

test("a later explicit Cursor model supersedes an earlier Auto state", () => {
  const summary = summarizeSession([
    event(1, null, "opaque_auto"),
    event(2, "gpt-5.6-sol", "explicit_model")
  ], "cursor");
  assert.equal(summary.model, "gpt-5.6-sol");
  assert.equal(summary.attributionEvent.attribution, "explicit_model");
});

test("multiple explicitly observed models are marked mixed", () => {
  const summary = summarizeSession([
    event(1, "claude-sonnet-5", "explicit_model"),
    event(2, "gpt-5.6-sol", "explicit_model")
  ], "cursor");
  assert.equal(summary.mixed, true);
  assert.equal(summary.model, null);
});
