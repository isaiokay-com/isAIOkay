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
