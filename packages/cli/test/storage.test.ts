import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson, LocalStore } from "../src/storage.js";
import type { StoredEvent, StoredUsageSlice } from "../src/types.js";

const event = (index: number): StoredEvent => ({
  schemaVersion: 1,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  provider: "codex",
  attribution: "active_model",
  model: "gpt-5.6-codex",
  sessionHash: "a".repeat(43),
  occurredAt: 1_700_000_000_000,
  recordedAt: 1_700_000_000_100
});

const usage = (index: number): StoredUsageSlice => ({
  schemaVersion: 1,
  id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  subscriptionId: "20000000-0000-4000-8000-000000000001",
  provider: "codex",
  tool: "codex",
  sessionHash: "a".repeat(43),
  requestHash: "b".repeat(42) + String(index % 10),
  requestedModel: null,
  reportedModel: "gpt-5.6-sol",
  modelFamily: null,
  modelVersion: null,
  reasoningEffort: "high",
  modelVariant: null,
  serviceTier: null,
  querySource: "main",
  granularity: "turn",
  attributionQuality: "exact",
  tokenAttributionQuality: "exact",
  modelAttributionQuality: "exact",
  effortAttributionQuality: "exact",
  inputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 5,
  reasoningTokens: 2,
  reportedTotalTokens: 15,
  observedAt: 1_700_000_000_000,
  recordedAt: 1_700_000_000_100
});

const temporaryStore = async (): Promise<{ directory: string; store: LocalStore }> => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  return {
    directory,
    store: new LocalStore({
      configFile: join(directory, "config", "config.json"),
      credentialFile: join(directory, "config", "credential.json"),
      stateFile: join(directory, "state", "state.json")
    })
  };
};

test("LocalStore writes only minimized events through private atomic files", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await store.getConfig();
  await store.recordEvent(event(1));

  const state = await store.getState();
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.pendingEventIds, [event(1).id]);
  const contents = await readFile(store.paths.stateFile, "utf8");
  assert.equal(contents.includes("private prompt contents"), false);
  assert.equal(contents.includes("cwd"), false);
  assert.equal(contents.includes("raw-session"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(store.paths.stateFile)).mode & 0o777, 0o600);
  }
});

test("LocalStore records a foreground lifecycle pair in one state mutation", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await store.recordEvents([event(1), event(2)]);

  const state = await store.getState();
  assert.deepEqual(state.events.map(({ id }) => id), [event(1).id, event(2).id]);
  assert.deepEqual(state.pendingEventIds, [event(1).id, event(2).id]);
  await assert.rejects(store.recordEvents([event(3), { ...event(4), id: "invalid" }]), /invalid minimized event/);
  assert.deepEqual((await store.getState()).events.map(({ id }) => id), [event(1).id, event(2).id]);
});

test("re-scanning the same provider request never requeues synced telemetry", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const first = usage(1);
  await store.recordTelemetry({ usage: [first] });
  await store.completeTelemetry([first.id], []);
  await store.recordTelemetry({ usage: [{ ...first, id: usage(2).id, recordedAt: first.recordedAt + 1 }] });
  const state = await store.getState();
  assert.deepEqual(state.usage.map(({ id }) => id), [first.id]);
  assert.deepEqual(state.pendingUsageIds, []);
});

test("onboarding state distinguishes fresh installs from pre-onboarding configs", async (context) => {
  const fresh = await temporaryStore();
  context.after(() => rm(fresh.directory, { recursive: true, force: true }));
  assert.equal((await fresh.store.getConfig()).onboardingCompletedAt, null);
  assert.equal((await fresh.store.completeOnboarding(1_700_000_000_000)).onboardingCompletedAt, 1_700_000_000_000);

  const legacy = await temporaryStore();
  context.after(() => rm(legacy.directory, { recursive: true, force: true }));
  await atomicWriteJson(legacy.store.paths.configFile, {
    schemaVersion: 1,
    hmacSecret: "a".repeat(43),
    adapters: {}
  });
  assert.equal((await legacy.store.getConfig()).onboardingCompletedAt, 1);
});

test("state written before hook reminders existed remains compatible", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await atomicWriteJson(store.paths.stateFile, {
    schemaVersion: 1,
    events: [],
    pendingEventIds: [],
    rate: {
      nextAllowedAt: null,
      promptShownAt: [1_700_000_000_000],
      promptsDisabled: false
    }
  });

  const state = await store.getState();
  assert.deepEqual(state.rate.hookReminderShownAt, []);
  assert.deepEqual(state.rate.promptShownAt, [1_700_000_000_000]);
});

test("concurrent config initialization and updates preserve one secret and every mutation", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const stores = Array.from({ length: 20 }, () => new LocalStore(store.paths));

  const initialized = await Promise.all(stores.map((candidate) => candidate.getConfig()));
  assert.equal(new Set(initialized.map(({ hmacSecret }) => hmacSecret)).size, 1);

  await Promise.all([
    stores[0]!.registerAdapter("codex", "installed", 100),
    stores[1]!.registerAdapter("claude", "installed", 200),
    stores[2]!.completeOnboarding(300)
  ]);
  const config = await store.getConfig();
  assert.equal(config.onboardingCompletedAt, 300);
  assert.equal(config.adapters.codex?.installedAt, 100);
  assert.equal(config.adapters.claude?.installedAt, 200);
});

test("LocalStore bounds history and pending scaffolding", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (let index = 0; index < 255; index += 1) await store.recordEvent(event(index));
  const state = await store.getState();
  assert.equal(state.events.length, 250);
  assert.equal(state.pendingEventIds.length, 100);
  assert.equal(state.events[0]?.id, event(5).id);
  await store.clearPending();
  assert.equal((await store.getState()).pendingEventIds.length, 0);
});

test("concurrent hook processes do not overwrite one another's events", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 40 }, (_, index) => store.recordEvent(event(index))));
  const state = await store.getState();
  assert.equal(state.events.length, 40);
  assert.equal(new Set(state.events.map(({ id }) => id)).size, 40);
});

test("concurrent hooks atomically claim only one prompt slot", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const sessionHash = "a".repeat(43);
  await store.recordEvent({ ...event(900), sessionHash, occurredAt: now - 21 * 60_000 });
  await store.recordEvent({ ...event(901), sessionHash, occurredAt: now });

  const decisions = await Promise.all(Array.from({ length: 20 }, () => store.claimPrompt(now)));
  assert.equal(decisions.filter(({ eligible }) => eligible).length, 1);
  assert.deepEqual((await store.getState()).rate.promptShownAt, [now]);
});

test("a failed foreground UI can release only its exact prompt reservation", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const sessionHash = "a".repeat(43);
  await store.recordEvent({ ...event(902), sessionHash, occurredAt: now - 21 * 60_000 });
  await store.recordEvent({ ...event(903), sessionHash, occurredAt: now });

  assert.equal((await store.claimPrompt(now)).eligible, true);
  await store.releasePromptClaim(now - 1);
  assert.deepEqual((await store.getState()).rate.promptShownAt, [now]);
  await store.releasePromptClaim(now);
  assert.deepEqual((await store.getState()).rate.promptShownAt, []);
  assert.equal((await store.claimPrompt(now)).eligible, true);
});

test("corrupt local state is treated as empty without exposing its contents", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(store.paths.stateFile, "{private transcript", "utf8").catch(async () => {
    await atomicWriteJson(store.paths.stateFile, { malformed: true });
  });
  const state = await store.getState();
  assert.deepEqual(state.events, []);
});

test("atomicWriteJson leaves no temporary artifact after a completed replacement", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-atomic-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "nested", "state.json");
  await atomicWriteJson(file, { schemaVersion: 1 });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { schemaVersion: 1 });
  assert.deepEqual(await readdir(join(directory, "nested")), ["state.json"]);
});
