import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicWriteJson } from "../src/storage.js";
import { installOwnedIntegration, uninstallOwnedIntegration } from "../src/integrations.js";

test("Codex installation preserves existing hooks and uninstall removes only the owned handlers", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-integrations-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".codex", "hooks.json");
  await atomicWriteJson(path, {
    description: "user hooks",
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "existing-command" }] }] }
  });
  const installed = await installOwnedIntegration("codex", home);
  assert.equal(installed.mode, "installed");
  const afterInstall = await readFile(path, "utf8");
  assert.match(afterInstall, /existing-command/);
  assert.match(afterInstall, /isaiokay hook --provider codex --quiet/);

  await uninstallOwnedIntegration("codex", home);
  const afterUninstall = await readFile(path, "utf8");
  assert.match(afterUninstall, /existing-command/);
  assert.equal(afterUninstall.includes("isaiokay hook"), false);
});

test("isolated OpenCode, Copilot, and Amp integrations contain no credential or endpoint", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-integrations-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const opencode = await installOwnedIntegration("opencode", home);
  const copilot = await installOwnedIntegration("copilot", home);
  const amp = await installOwnedIntegration("amp", home);
  const contents = `${await readFile(opencode.path!, "utf8")}\n${await readFile(copilot.path!, "utf8")}\n${await readFile(amp.path!, "utf8")}`;
  assert.match(contents, /isaiokay/);
  assert.match(contents, /client\.tui\.showToast/);
  assert.match(contents, /ctx\.ui\.notify/);
  assert.match(contents, /agentStop/);
  assert.doesNotMatch(contents, /JSON\.stringify\(event\)/);
  assert.equal(contents.includes("iai_"), false);
  assert.equal(contents.includes("isaiokay.com"), false);
  await uninstallOwnedIntegration("opencode", home);
  await uninstallOwnedIntegration("copilot", home);
  await uninstallOwnedIntegration("amp", home);
});

test("OpenCode groups deduplicated root and subagent models into one safe idle envelope", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-integrations-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const installed = await installOwnedIntegration("opencode", home);
  const source = await readFile(installed.path!, "utf8");
  const payloads: Array<Record<string, unknown>> = [];
  const runtime = globalThis as typeof globalThis & { Bun?: { spawn: (command: string[], options: { stdin: string }) => unknown } };
  const previousBun = runtime.Bun;
  runtime.Bun = {
    spawn: (_command, options) => {
      payloads.push(JSON.parse(options.stdin) as Record<string, unknown>);
      return { stdout: new Blob(["{}"]).stream(), exited: Promise.resolve(0) };
    }
  };
  context.after(() => {
    if (previousBun === undefined) delete runtime.Bun;
    else runtime.Bun = previousBun;
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const pluginModule = await import(moduleUrl) as { IsAiOkay: (input: unknown) => Promise<{ event: (input: unknown) => Promise<void> }> };
  const plugin = await pluginModule.IsAiOkay({ client: { tui: { showToast: async () => undefined } } });

  await plugin.event({ event: { type: "session.created", properties: { info: { id: "root-session" } } } });
  await plugin.event({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "root-session" } } } });
  await plugin.event({ event: { type: "session.updated", properties: { info: { id: "child-session" } } } });
  const rootMessage = {
    type: "message.updated",
    properties: { info: { id: "root-message", sessionID: "root-session", role: "assistant", providerID: "opencode-go", modelID: "stale-model" } }
  };
  await plugin.event({ event: rootMessage });
  await plugin.event({ event: {
    type: "message.updated",
    properties: { info: { ...rootMessage.properties.info, modelID: "kimi-k3" } }
  } });
  await plugin.event({ event: {
    type: "message.updated",
    properties: { info: { id: "summary-message", sessionID: "root-session", role: "assistant", providerID: "internal", modelID: "summary-model", summary: true } }
  } });
  await plugin.event({ event: {
    type: "message.updated",
    properties: { info: { id: "child-message", sessionID: "child-session", role: "assistant", providerID: "opencode-go", modelID: "deepseek-v4-pro" } }
  } });
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "child-session" } } });
  assert.deepEqual(payloads, []);

  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "root-session" } } });
  assert.deepEqual(payloads, [
    { event: "isaiokay.opencode.model", sessionID: "root-session", providerID: "opencode-go", modelID: "kimi-k3" },
    { event: "isaiokay.opencode.model", sessionID: "root-session", providerID: "opencode-go", modelID: "deepseek-v4-pro" },
    { event: "session.idle", sessionID: "root-session" }
  ]);
  assert.equal(JSON.stringify(payloads).includes("stale-model"), false);
  assert.equal(JSON.stringify(payloads).includes("summary-model"), false);
  assert.equal(JSON.stringify(payloads).includes("root-message"), false);
  assert.equal(JSON.stringify(payloads).includes("child-message"), false);
});

test("Gemini installation preserves existing settings and removes only owned hooks", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-integrations-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".gemini", "settings.json");
  await atomicWriteJson(path, {
    theme: "user-theme",
    hooks: { AfterAgent: [{ matcher: "*", hooks: [{ type: "command", command: "existing-command" }] }] }
  });

  await installOwnedIntegration("gemini", home);
  const installed = await readFile(path, "utf8");
  assert.match(installed, /user-theme/);
  assert.match(installed, /existing-command/);
  assert.match(installed, /BeforeModel/);
  assert.match(installed, /AfterAgent/);
  assert.match(installed, /isaiokay hook --provider gemini --quiet/);

  await uninstallOwnedIntegration("gemini", home);
  const uninstalled = await readFile(path, "utf8");
  assert.match(uninstalled, /user-theme/);
  assert.match(uninstalled, /existing-command/);
  assert.doesNotMatch(uninstalled, /isaiokay hook/);
});

test("Cursor installation merges documented global hooks and removes only owned commands", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-integrations-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".cursor", "hooks.json");
  await atomicWriteJson(path, {
    version: 1,
    hooks: { stop: [{ command: "existing-stop" }] }
  });

  await installOwnedIntegration("cursor", home);
  const installed = await readFile(path, "utf8");
  assert.match(installed, /existing-stop/);
  assert.match(installed, /sessionStart/);
  assert.match(installed, /isaiokay hook --provider cursor --quiet/);

  await uninstallOwnedIntegration("cursor", home);
  const uninstalled = await readFile(path, "utf8");
  assert.match(uninstalled, /existing-stop/);
  assert.doesNotMatch(uninstalled, /isaiokay hook/);
});

test("Grok Build uses an isolated lifecycle hook file", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-integrations-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const installed = await installOwnedIntegration("grok", home);
  assert.equal(installed.path, join(home, ".grok", "hooks", "isaiokay.json"));
  const contents = await readFile(installed.path!, "utf8");
  assert.match(contents, /SessionStart/);
  assert.match(contents, /Stop/);
  assert.match(contents, /isaiokay hook --provider grok --quiet/);
  await uninstallOwnedIntegration("grok", home);
  await assert.rejects(readFile(installed.path!, "utf8"), /ENOENT/);
});

test("malformed provider configuration is never overwritten", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-integrations-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".claude", "settings.json");
  await atomicWriteJson(path, { valid: true });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(path, "{broken", "utf8"));
  await assert.rejects(() => installOwnedIntegration("claude", home), /Refusing to overwrite malformed/);
  assert.equal(await readFile(path, "utf8"), "{broken");
});
