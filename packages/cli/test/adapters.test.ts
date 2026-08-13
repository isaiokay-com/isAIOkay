import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorAdapter, getAdapterPlan, installAdapter, providerAdapters, uninstallAdapter } from "../src/adapters.js";
import { LocalStore } from "../src/storage.js";

const temporaryStore = async (): Promise<{ directory: string; store: LocalStore }> => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-adapter-"));
  return {
    directory,
    store: new LocalStore({
      configFile: join(directory, "isaiokay", "config.json"),
      credentialFile: join(directory, "isaiokay", "credential.json"),
      stateFile: join(directory, "isaiokay", "state.json")
    })
  };
};

test("codex install writes the owned hooks file, registers installed, and doctor reflects it", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const codexDirectory = join(directory, ".codex");
  const codexConfig = join(codexDirectory, "config.toml");
  await mkdir(codexDirectory, { recursive: true });
  await writeFile(codexConfig, "provider-owned = true\n", "utf8");

  const { plan, integration } = await installAdapter(store, "codex", { now: 123, home: directory });
  assert.equal(plan.mode, "install");
  assert.match(plan.hookCommand, /isaiokay hook --provider codex/);
  assert.equal(integration.mode, "installed");
  assert.equal(await readFile(codexConfig, "utf8"), "provider-owned = true\n");
  const hooks = JSON.parse(await readFile(join(codexDirectory, "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
  assert.ok(JSON.stringify(hooks.hooks).includes("isaiokay hook --provider codex --quiet"));
  assert.equal((await store.getConfig()).adapters.codex?.mode, "installed");
  assert.equal((await store.getConfig()).adapters.codex?.installedAt, 123);

  const doctor = await doctorAdapter(store, "codex", directory);
  assert.deepEqual(doctor, {
    provider: "codex",
    mode: "install",
    registered: true,
    candidateConfigFound: true,
    ownedIntegrationFound: true,
    message: plan.reason
  });

  await uninstallAdapter(store, "codex", { home: directory });
  assert.equal((await store.getConfig()).adapters.codex, undefined);
  assert.equal((await doctorAdapter(store, "codex", directory)).ownedIntegrationFound, false);
});

test("manual adapters never rewrite a provider config and doctor reports their honest state", async (context) => {
  const { directory, store } = await temporaryStore();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { plan, integration } = await installAdapter(store, "aider", { now: 456, home: directory });
  assert.equal(plan.mode, "manual");
  assert.equal(integration.mode, "manual");
  assert.equal(integration.path, null);
  const doctor = await doctorAdapter(store, "aider", directory);
  assert.deepEqual(doctor, {
    provider: "aider",
    mode: "manual",
    registered: false,
    candidateConfigFound: false,
    ownedIntegrationFound: false,
    message: plan.reason
  });
  await uninstallAdapter(store, "aider", { home: directory });
  assert.equal((await store.getConfig()).adapters.aider, undefined);
});

test("adapter metadata matches the supported auto-install and explicit manual/bridge sets", () => {
  const providers = providerAdapters.map((adapter) => adapter.provider);
  assert.deepEqual(providers, ["codex", "claude", "cursor", "opencode", "gemini", "copilot", "cline", "windsurf", "aider", "amp", "grok", "qwen", "kimi", "muse"]);
  assert.equal(providers.includes("roo" as never), false);
  for (const provider of ["codex", "claude", "cursor", "opencode", "gemini", "copilot", "amp", "grok", "qwen", "kimi"] as const) {
    assert.equal(providerAdapters.find((adapter) => adapter.provider === provider)?.mode, "install");
    assert.equal(getAdapterPlan(provider).mode, "install");
  }
  assert.equal(getAdapterPlan("cursor").mode, "install");
  assert.equal(providerAdapters.find((adapter) => adapter.provider === "cursor")?.mode, "install");
  assert.equal(getAdapterPlan("aider").mode, "manual");
  assert.equal(getAdapterPlan("cline").mode, "bridge");
  assert.equal(getAdapterPlan("windsurf").mode, "bridge");
  assert.equal(getAdapterPlan("muse").mode, "manual");
  assert.equal(providerAdapters.find((adapter) => adapter.provider === "cline")?.normalize({ event: "TaskCancel", provider: "openai", slug: "gpt-5", taskId: "private" }, "secret").accepted, true);
});
