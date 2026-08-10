import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import { detectShell, installShellIntegration, renderShellIntegration, shellIntegrationInstalled, shellIntegrationPath, uninstallShellIntegration } from "../src/shell-integration.js";

test("shell detection accepts only supported interactive shells", () => {
  assert.equal(detectShell({ SHELL: "/bin/zsh" }), "zsh");
  assert.equal(detectShell({ SHELL: "/usr/local/bin/bash" }), "bash");
  assert.equal(detectShell({ SHELL: "/opt/homebrew/bin/fish" }), "fish");
  assert.equal(detectShell({ SHELL: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" }, "win32"), "powershell");
  assert.equal(detectShell({ SHELL: "/usr/bin/pwsh" }, "linux"), "powershell");
  assert.equal(detectShell({}, "win32"), "powershell");
  assert.equal(detectShell({ SHELL: "" }, "win32"), "powershell");
  assert.equal(detectShell({ SHELL: "/bin/tcsh" }), null);
  assert.equal(detectShell({}), null);
});

test("PowerShell profiles follow platform conventions and allow the exact host profile", () => {
  assert.equal(
    shellIntegrationPath("powershell", "/users/dev", { platform: "linux" }),
    join("/users/dev", ".config", "powershell", "profile.ps1")
  );
  assert.equal(
    shellIntegrationPath("powershell", "C:\\Users\\dev", { platform: "win32", env: {} }),
    win32.join("C:\\Users\\dev", "Documents", "WindowsPowerShell", "Profile.ps1")
  );
  assert.equal(
    shellIntegrationPath("powershell", "C:\\Users\\dev", {
      platform: "win32",
      env: { POWERSHELL_DISTRIBUTION_CHANNEL: "MSI:Windows 10 Pro" }
    }),
    win32.join("C:\\Users\\dev", "Documents", "PowerShell", "Profile.ps1")
  );
  assert.equal(
    shellIntegrationPath("powershell", "C:\\Users\\dev", {
      platform: "win32",
      env: {
        PSModulePath: "C:\\Users\\dev\\OneDrive\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\Modules"
      }
    }),
    "C:\\Users\\dev\\OneDrive\\Documents\\PowerShell\\Profile.ps1"
  );
  assert.equal(
    shellIntegrationPath("powershell", "/users/dev", { profilePath: "/redirected/Profile.ps1" }),
    "/redirected/Profile.ps1"
  );
});

test("Bash profiles follow Linux and macOS login-shell conventions", () => {
  assert.equal(shellIntegrationPath("bash", "/users/dev", { platform: "linux" }), "/users/dev/.bashrc");
  assert.equal(shellIntegrationPath("bash", "/users/dev", { platform: "darwin" }), "/users/dev/.bash_profile");
});

test("managed zsh integration preserves user configuration and is idempotent", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-shell-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".zshrc");
  const original = "export USER_SETTING=preserved\n";
  await writeFile(path, original, "utf8");

  assert.deepEqual(await installShellIntegration("zsh", home), { path, changed: true });
  const installed = await readFile(path, "utf8");
  assert.match(installed, /USER_SETTING=preserved/);
  assert.match(installed, /codex\(\).*isaiokay run codex/);
  assert.match(installed, /claude\(\).*isaiokay run claude/);
  assert.match(installed, /agent\(\).*isaiokay run cursor/);
  assert.match(installed, /grok\(\).*isaiokay run grok/);
  assert.match(installed, /muse\(\).*isaiokay run muse/);
  assert.match(installed, /\[ -t 0 \].*\[ -t 1 \]/);
  assert.match(installed, /! \$\+functions\[codex\].*! \$\+aliases\[codex\]/);
  assert.equal(await shellIntegrationInstalled("zsh", home), true);

  assert.deepEqual(await installShellIntegration("zsh", home), { path, changed: false });
  assert.equal(await readFile(path, "utf8"), installed);
  assert.deepEqual(await uninstallShellIntegration("zsh", home), { path, changed: true });
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await shellIntegrationInstalled("zsh", home), false);
});

test("shell installation refuses malformed or duplicate managed blocks", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-shell-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".bashrc"), "# >>> isaiokay automatic questionnaire >>>\n", "utf8");
  await assert.rejects(installShellIntegration("bash", home), /malformed/i);
});

test("shell installation preserves symlinked dotfiles and edits their target", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-shell-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const dotfiles = join(home, "dotfiles");
  const target = join(dotfiles, "zshrc");
  const path = join(home, ".zshrc");
  await mkdir(dotfiles);
  await writeFile(target, "export DOTFILES=preserved\n", "utf8");
  await symlink(target, path);

  await installShellIntegration("zsh", home);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.match(await readFile(target, "utf8"), /isaiokay run codex/);
  await uninstallShellIntegration("zsh", home);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.equal(await readFile(target, "utf8"), "export DOTFILES=preserved\n");
});

test("shell installation refuses to replace a broken startup symlink", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-shell-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".zshrc");
  await symlink(join(home, "missing-zshrc"), path);

  await assert.rejects(installShellIntegration("zsh", home), /symlink.*target is missing/i);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
});

test("fish uses an isolated app-owned startup file", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-shell-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".config", "fish", "conf.d", "isaiokay.fish");
  assert.deepEqual(await installShellIntegration("fish", home), { path, changed: true });
  assert.equal(await readFile(path, "utf8"), renderShellIntegration("fish"));
  await writeFile(path, `${renderShellIntegration("fish")}# user content\n`, "utf8");
  await assert.rejects(installShellIntegration("fish", home), /refusing/i);
  await assert.rejects(uninstallShellIntegration("fish", home), /refusing/i);
  await writeFile(path, renderShellIntegration("fish"), "utf8");
  assert.deepEqual(await uninstallShellIntegration("fish", home), { path, changed: true });
  await assert.rejects(readFile(path, "utf8"));
});

test("managed PowerShell integration preserves the profile and wraps Windows command shims", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-shell-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "OneDrive", "Documents", "PowerShell", "Profile.ps1");
  await mkdir(join(home, "OneDrive", "Documents", "PowerShell"), { recursive: true });
  const original = "$env:USER_SETTING = 'preserved'\r\n";
  await writeFile(path, original, "utf8");
  const options = { platform: "win32" as const, profilePath: path };

  assert.deepEqual(await installShellIntegration("powershell", home, options), { path, changed: true });
  const installed = await readFile(path, "utf8");
  assert.match(installed, /USER_SETTING = 'preserved'/);
  assert.match(installed, /function global:codex.*isaiokay.*run codex/);
  assert.match(installed, /function global:claude.*isaiokay.*run claude/);
  assert.match(installed, /Get-Command codex -CommandType Application/);
  assert.match(installed, /\[Console\]::IsInputRedirected/);
  assert.doesNotMatch(installed, /\nfi\n/);
  assert.doesNotMatch(installed, /(?<!\r)\n/u);
  assert.equal(await shellIntegrationInstalled("powershell", home, options), true);
  assert.deepEqual(await installShellIntegration("powershell", home, options), { path, changed: false });
  assert.deepEqual(await uninstallShellIntegration("powershell", home, options), { path, changed: true });
  assert.equal(await readFile(path, "utf8"), original);
});
