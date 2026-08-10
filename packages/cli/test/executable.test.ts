import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserLaunchCommand } from "../src/browser.js";
import { detectOneShotRunner, executableExists } from "../src/executable.js";

test("Windows browser launching does not invoke a command shell", () => {
  const launch = browserLaunchCommand("win32", "https://isaiokay.com/cli/authorize?code=A&B");
  assert.equal(launch.command, "rundll32.exe");
  assert.deepEqual(launch.args, ["url.dll,FileProtocolHandler", "https://isaiokay.com/cli/authorize?code=A&B"]);
});

test("one-shot runner detection distinguishes temporary package environments", () => {
  assert.equal(detectOneShotRunner({ npm_lifecycle_event: "npx" }), "npx");
  assert.equal(detectOneShotRunner({ npm_lifecycle_event: "bunx" }), "bunx");
  assert.equal(detectOneShotRunner({
    npm_config_user_agent: "pnpm/10.28.2 npm/? node/v24.11.0 linux x64",
    PATH: "/home/dev/.cache/pnpm/dlx/abc/node_modules/.bin:/usr/bin"
  }), "pnpm dlx");
  assert.equal(detectOneShotRunner({
    npm_config_user_agent: "pnpm/10.28.2 npm/? node/v24.11.0 linux x64",
    PATH: "/home/dev/.local/share/pnpm:/usr/bin"
  }), null);
  assert.equal(detectOneShotRunner({ PATH: "/usr/local/bin:/usr/bin" }), null);
});

test("executable detection checks PATH without invoking the detected program", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-path-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, "sample-cli");
  await writeFile(executable, "#!/bin/sh\nexit 99\n", "utf8");
  await chmod(executable, 0o755);

  assert.equal(await executableExists("sample-cli", { env: { PATH: directory }, platform: "linux" }), true);
  assert.equal(await executableExists("missing-cli", { env: { PATH: directory }, platform: "linux" }), false);
});
