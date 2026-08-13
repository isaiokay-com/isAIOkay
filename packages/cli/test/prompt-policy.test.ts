import assert from "node:assert/strict";
import test from "node:test";
import { decidePrompt, pendingSessionCount, recordedSessionCount, reminderStatus, selectRateableSession } from "../src/prompt-policy.js";
import type { LocalState, StoredEvent } from "../src/types.js";

const now = 1_800_000_000_000;

const event = (id: string, sessionHash: string, occurredAt: number): StoredEvent => ({
  schemaVersion: 1,
  id,
  provider: "codex",
  attribution: "active_model",
  model: "gpt-5.6-sol",
  sessionHash,
  occurredAt,
  recordedAt: occurredAt
});

const stateFor = (sessionHash: string): LocalState => {
  const start = event("00000000-0000-4000-8000-000000000001", sessionHash, now - 21 * 60_000);
  const end = event("00000000-0000-4000-8000-000000000002", sessionHash, now);
  return {
    schemaVersion: 1,
    events: [start, end],
    pendingEventIds: [start.id, end.id],
    rate: { nextAllowedAt: null, hookReminderShownAt: [], promptShownAt: [], promptsDisabled: false }
  };
};

test("prompt cadence requires twenty minutes of meaningful usage without random sampling", () => {
  const state = stateFor("a".repeat(43));
  assert.deepEqual(decidePrompt(state, now), { eligible: true, reason: "eligible", eventId: state.events[1]?.id });
  state.events[0] = { ...state.events[0]!, occurredAt: now - 19 * 60_000 };
  assert.equal(decidePrompt(state, now).reason, "no_meaningful_experience");
});

test("short sessions accumulate into a meaningful daily experience", () => {
  const state = stateFor("a".repeat(43));
  const secondStart = event("00000000-0000-4000-8000-000000000003", "b".repeat(43), now - 9 * 60_000);
  const secondEnd = event("00000000-0000-4000-8000-000000000004", "b".repeat(43), now);
  state.events = [
    { ...state.events[0]!, occurredAt: now - 31 * 60_000 },
    { ...state.events[1]!, occurredAt: now - 20 * 60_000 },
    secondStart,
    secondEnd
  ];
  state.pendingEventIds = state.events.map(({ id }) => id);
  assert.deepEqual(decidePrompt(state, now), { eligible: true, reason: "eligible", eventId: secondEnd.id });
});

test("a newer start-only session cannot displace the completed session selected for rating", () => {
  const state = stateFor("a".repeat(43));
  state.events = state.events.map((entry) => ({ ...entry, occurredAt: entry.occurredAt - 1_000 }));
  const unrelatedStart = {
    ...event("00000000-0000-4000-8000-000000000003", "b".repeat(43), now),
    provider: "claude" as const,
    attribution: "session_start" as const,
    model: "claude-sonnet-5"
  };
  state.events.push(unrelatedStart);
  state.pendingEventIds.push(unrelatedStart.id);

  assert.deepEqual(decidePrompt(state, now), {
    eligible: true,
    reason: "eligible",
    eventId: state.events[1]!.id
  });
  assert.equal(reminderStatus(state, now).pendingSessionCountToday, 1);
  const shellHash = "s".repeat(43);
  state.events[0] = { ...state.events[0]!, shellHash };
  state.events[1] = { ...state.events[1]!, shellHash };
  assert.deepEqual(selectRateableSession(state, undefined, shellHash, now)?.map(({ id }) => id), state.events.slice(0, 2).map(({ id }) => id));
  assert.equal(selectRateableSession(state, undefined, shellHash, now + 31 * 60_000), null);
});

test("an explicit rating cannot select a start-only session", () => {
  const state = stateFor("a".repeat(43));
  state.events = [{
    ...state.events[0]!,
    provider: "claude",
    attribution: "session_start",
    model: "claude-sonnet-5"
  }];
  state.pendingEventIds = state.events.map(({ id }) => id);
  assert.equal(selectRateableSession(state, undefined, "s".repeat(43), now), null);
  assert.equal(selectRateableSession(state, state.events[0]!.id), null);
});

test("prompt cadence enforces cooldown, a local-calendar daily cap, and never-ask-again", () => {
  const state = stateFor("a".repeat(43));
  state.rate.nextAllowedAt = now + 1;
  assert.equal(decidePrompt(state, now).reason, "cooldown");
  state.rate.nextAllowedAt = null;
  state.rate.promptShownAt = [now - 1_000];
  assert.equal(decidePrompt(state, now).reason, "daily_cap");
  state.rate.promptShownAt = [now - 2 * 86_400_000, now - 3 * 86_400_000, now - 4 * 86_400_000];
  assert.equal(decidePrompt(state, now).reason, "eligible");
  state.rate.promptsDisabled = true;
  assert.equal(decidePrompt(state, now).reason, "disabled");
});

test("a hook reminder does not consume the foreground questionnaire slot", () => {
  const state = stateFor("a".repeat(43));
  state.rate.hookReminderShownAt = [now - 1_000];
  assert.equal(decidePrompt(state, now, "hook").reason, "daily_cap");
  assert.equal(decidePrompt(state, now, "foreground").reason, "eligible");

  state.rate.promptShownAt = [now];
  assert.equal(decidePrompt(state, now, "hook").reason, "daily_cap");
  assert.equal(decidePrompt(state, now, "foreground").reason, "daily_cap");
});

test("yesterday's pending activity does not trigger today's reminder", () => {
  const state = stateFor("a".repeat(43));
  state.events = state.events.map((entry) => ({ ...entry, occurredAt: entry.occurredAt - 24 * 60 * 60_000 }));
  assert.equal(decidePrompt(state, now).reason, "no_meaningful_experience");
});

test("status reports session counts and shared cadence details rather than event counts", () => {
  const state = stateFor("a".repeat(43));
  const secondStart = event("00000000-0000-4000-8000-000000000003", "b".repeat(43), now - 10 * 60_000);
  const secondEnd = event("00000000-0000-4000-8000-000000000004", "b".repeat(43), now);
  state.events.push(secondStart, secondEnd);
  state.pendingEventIds.push(secondStart.id, secondEnd.id);

  assert.equal(recordedSessionCount(state), 2);
  assert.equal(pendingSessionCount(state), 2);
  assert.deepEqual(reminderStatus(state, now), {
    eligible: true,
    reason: "eligible",
    eventId: state.events[1]!.id,
    experiencedMs: 31 * 60_000,
    rateableExperiencedMs: 31 * 60_000,
    pendingSessionCountToday: 2,
    requiredExperienceMs: 20 * 60_000,
    remainingExperienceMs: 0,
    nextAllowedAt: null,
    lastPromptAt: null
  });

  state.pendingEventIds = [];
  assert.equal(pendingSessionCount(state), 0);
  assert.deepEqual(reminderStatus(state, now), {
    eligible: false,
    reason: "no_meaningful_experience",
    eventId: null,
    experiencedMs: 31 * 60_000,
    rateableExperiencedMs: 0,
    pendingSessionCountToday: 0,
    requiredExperienceMs: 20 * 60_000,
    remainingExperienceMs: 20 * 60_000,
    nextAllowedAt: null,
    lastPromptAt: null
  });
});
