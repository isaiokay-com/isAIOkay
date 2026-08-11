import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { detectBrowserAvailability } from "../src/browser.js";
import { getCliTurnstileChallenge, normalizeSameOriginWebUrl, pollDeviceLogin, startDeviceLogin, stripTerminalControls } from "../src/api.js";
import { runCli, type CliIo } from "../src/cli.js";
import { decidePrompt } from "../src/prompt-policy.js";
import { LocalStore, resolveStoragePaths } from "../src/storage.js";
import { PROVIDERS } from "../src/types.js";

interface CapturedIo {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
}

test("browser URLs must stay on the configured server origin", () => {
  assert.equal(normalizeSameOriginWebUrl("https://isaiokay.com/cli/authorize", "https://isaiokay.com"), "https://isaiokay.com/cli/authorize");
  assert.equal(normalizeSameOriginWebUrl("https://attacker.example/authorize", "https://isaiokay.com"), null);
  assert.equal(normalizeSameOriginWebUrl("javascript:alert(1)", "https://isaiokay.com"), null);
});

test("remote text cannot inject terminal control sequences", () => {
  assert.equal(stripTerminalControls("safe\u001b[2J\ntext"), "safe[2Jtext");
});

test("device login rejects malformed or unbounded server fields", async () => {
  const malformedStart = async () => Response.json({
    deviceCode: "a".repeat(64),
    userCode: "SAFE\u001b[2J",
    verificationUriComplete: "https://isaiokay.com/cli/authorize",
    expiresIn: Number.MAX_SAFE_INTEGER,
    interval: 3
  });
  await assert.rejects(startDeviceLogin(malformedStart as typeof fetch, "https://isaiokay.com"), /invalid device authorization response/i);

  const malformedToken = async () => Response.json({ accessToken: "not-a-scoped-token", expiresIn: 3600 });
  await assert.rejects(pollDeviceLogin(malformedToken as typeof fetch, "https://isaiokay.com", "a".repeat(64)), /invalid CLI credential response/i);
});

test("browser challenge polling rejects malformed or mismatched UUIDs", async () => {
  const requestedId = "11111111-1111-4111-8111-111111111111";
  const credential = {
    schemaVersion: 1 as const,
    serverUrl: "https://isaiokay.com",
    accessToken: `iai_${"a".repeat(64)}`,
    expiresAt: Date.now() + 60_000
  };
  const mismatched = async () => Response.json({
    id: "22222222-2222-4222-8222-222222222222",
    status: "verified",
    expiresAt: Date.now() + 60_000,
    challengeProof: "b".repeat(64)
  });
  await assert.rejects(
    getCliTurnstileChallenge(mismatched as typeof fetch, credential, requestedId),
    /invalid browser verification status/i
  );
});

const capturedIo = (input: string, overrides: Partial<CliIo> = {}, isTTY = false): CapturedIo => {
  let out = "";
  let err = "";
  const writer = (target: "out" | "err") => ({
    isTTY,
    write: (chunk: string | Uint8Array): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (target === "out") out += text;
      else err += text;
      return true;
    }
  });
  return {
    io: {
      stdin: Readable.from([input]),
      stdout: writer("out") as CliIo["stdout"],
      stderr: writer("err") as CliIo["stderr"],
      env: {},
      now: () => 1_700_000_000_000,
      ...overrides
    },
    stdout: () => out,
    stderr: () => err
  };
};

const wrapperId = "00000000-0000-4000-8000-000000000099";

test("version output matches the package metadata", async () => {
  const metadata = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  const output = capturedIo("");
  assert.equal(await runCli(["--version"], output.io), 0);
  assert.equal(output.stdout(), `${metadata.version}\n`);
});

test("hook is noninteractive, returns success on rejected input, and persists only safe state", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const privateSession = "private-session-value";
  const privatePrompt = "a prompt that must never reach disk";
  const captured = capturedIo(JSON.stringify({ event: "model.active", model: "gpt-5.6-codex", session_id: privateSession, prompt: privatePrompt }));
  const exitCode = await runCli(["hook", "--provider", "codex", "--config-dir", configDir, "--state-dir", stateDir], captured.io);
  assert.equal(exitCode, 0);
  const response = JSON.parse(captured.stdout()) as Record<string, unknown>;
  assert.equal(response.accepted, true);
  assert.equal(captured.stdout().includes(privateSession), false);
  assert.equal(captured.stdout().includes(privatePrompt), false);
  const state = await readFile(join(stateDir, "isaiokay", "state.json"), "utf8");
  assert.equal(state.includes(privateSession), false);
  assert.equal(state.includes(privatePrompt), false);

  const rejected = capturedIo("not-json");
  assert.equal(await runCli(["hook", "--provider", "codex", "--config-dir", configDir, "--state-dir", stateDir], rejected.io), 0);
  assert.match(rejected.stdout(), /"accepted":false/);
});

test("a safe turn hook can remind during a long-running foreground wrapper", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  await store.getConfig();
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  const env = { ISAI_OKAY_FOREGROUND_SESSION: wrapperId, ISAI_OKAY_FOREGROUND_PROVIDER: "codex" };
  const now = 1_800_000_000_000;

  const start = capturedIo(JSON.stringify({
    hook_event_name: "SessionStart",
    model: "gpt-5.6-sol",
    session_id: "provider-private-session"
  }), { env, now: () => now - 21 * 60_000 });
  assert.equal(await runCli(["hook", "--provider", "codex", ...base], start.io), 0);
  assert.match(start.stdout(), /"promptDeferredToForeground":true/);

  const stop = capturedIo(JSON.stringify({
    hook_event_name: "Stop",
    model: "gpt-5.6-sol",
    session_id: "provider-private-session"
  }), { env, now: () => now });
  assert.equal(await runCli(["hook", "--provider", "codex", ...base], stop.io), 0);
  assert.match(stop.stdout(), /real time with Codex today/);

  const state = await store.getState();
  assert.equal(state.events.length, 2);
  assert.equal(state.events[0]?.sessionHash, state.events[1]?.sessionHash);
  assert.deepEqual(state.rate.hookReminderShownAt, [now]);
  assert.deepEqual(state.rate.promptShownAt, []);
  assert.equal(decidePrompt(state, now, "foreground").eligible, true);
  assert.doesNotMatch(await readFile(store.paths.stateFile, "utf8"), /provider-private-session/);
});

test("a hook reminder from one harness cannot suppress another harness's exit questionnaire", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  const reminderAt = 1_800_000_000_000;
  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  await store.saveCredential({
    schemaVersion: 1,
    serverUrl: "https://isaiokay.com",
    accessToken: `iai_${"a".repeat(64)}`,
    expiresAt: reminderAt + 86_400_000
  });

  for (const [hookEventName, occurredAt] of [
    ["SessionStart", reminderAt - 21 * 60_000],
    ["Stop", reminderAt]
  ] as const) {
    const hook = capturedIo(JSON.stringify({
      hook_event_name: hookEventName,
      model: "gpt-5.6-sol",
      session_id: "codex-private-session"
    }), { now: () => occurredAt });
    assert.equal(await runCli(["hook", "--provider", "codex", ...base], hook.io), 0);
    if (hookEventName === "Stop") assert.match(hook.stdout(), /real time with Codex today/);
  }

  let formOpened = false;
  const ids = [
    wrapperId,
    "00000000-0000-4000-8000-000000000111",
    "00000000-0000-4000-8000-000000000112"
  ];
  let idIndex = 0;
  const exitedAt = reminderAt + 60_000;
  let launched: { command: string; args: string[]; provider: string | undefined } | null = null;
  const wrapped = capturedIo("", {
    env: { TERM: "xterm-256color" },
    now: () => exitedAt,
    fetch: async (input) => String(input).endsWith("/api/cli/items")
      ? Response.json({ items: [{ id: "1", slug: "claude-sonnet-5", name: "Claude Sonnet 5", providerName: "Anthropic", type: "model" }] })
      : Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 }),
    createId: () => ids[idIndex++]!,
    runCommand: async (command, args, env) => {
      launched = { command, args, provider: env.ISAI_OKAY_FOREGROUND_PROVIDER };
      return { exitCode: 0, wrapperShuttingDown: false };
    },
    form: async () => { formOpened = true; return undefined; }
  }, true);

  assert.equal(await runCli([
    "run", "claude", "--config-dir", configDir, "--state-dir", stateDir
  ], wrapped.io), 0);
  assert.deepEqual(launched, { command: "claude", args: [], provider: "claude" });
  assert.equal(formOpened, true);
  assert.match(wrapped.stdout(), /Skipped for today/i);

  const state = await store.getState();
  assert.deepEqual(state.rate.hookReminderShownAt, [reminderAt]);
  assert.deepEqual(state.rate.promptShownAt, [exitedAt]);
  assert.equal(decidePrompt(state, exitedAt, "foreground").eligible, false);
});

test("a hook without a native notification surface never consumes the daily reminder", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  const now = 1_800_000_000_000;

  for (const occurredAt of [now - 21 * 60_000, now]) {
    const hook = capturedIo(JSON.stringify({ event: "agentStop", sessionId: "copilot-private-session" }), { now: () => occurredAt });
    assert.equal(await runCli(["hook", "--provider", "copilot", ...base], hook.io), 0);
    assert.doesNotMatch(hook.stdout(), /systemMessage|real time/);
  }

  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  assert.deepEqual((await store.getState()).rate.hookReminderShownAt, []);
  assert.equal(decidePrompt(await store.getState(), now).eligible, true);
});

test("run wraps any harness, forwards arguments unchanged, and asks only after exit", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  await store.getConfig();
  await store.saveCredential({
    schemaVersion: 1,
    serverUrl: "https://isaiokay.com",
    accessToken: `iai_${"a".repeat(64)}`,
    expiresAt: 1_800_000_000_000 + 86_400_000
  });
  const ids = [
    wrapperId,
    "00000000-0000-4000-8000-000000000101",
    "00000000-0000-4000-8000-000000000102"
  ];
  let idIndex = 0;
  let now = 1_800_000_000_000 - 21 * 60_000;
  let formOpened = false;
  let launched: { command: string; args: string[]; provider: string | undefined; session: string | undefined } | null = null;
  const output = capturedIo("", {
    env: { TERM: "xterm-256color" },
    now: () => now,
    fetch: async (input) => String(input).endsWith("/api/cli/items")
      ? Response.json({ items: [{ id: "1", slug: "gpt-5-6-sol", name: "GPT-5.6 Sol", providerName: "OpenAI", type: "model" }] })
      : Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 }),
    createId: () => ids[idIndex++]!,
    runCommand: async (command, args, env) => {
      launched = { command, args, provider: env.ISAI_OKAY_FOREGROUND_PROVIDER, session: env.ISAI_OKAY_FOREGROUND_SESSION };
      now += 21 * 60_000;
      return { exitCode: 23, wrapperShuttingDown: false };
    },
    form: async () => { formOpened = true; return undefined; }
  }, true);

  assert.equal(await runCli([
    "run", "cursor", "--command", "agent",
    "--config-dir", configDir, "--state-dir", stateDir,
    "--", "--resume", "private-command-argument"
  ], output.io), 23);
  assert.deepEqual(launched, { command: "agent", args: ["--resume", "private-command-argument"], provider: "cursor", session: wrapperId });
  assert.equal(formOpened, true);
  assert.match(output.stdout(), /Skipped for today/i);

  const state = await store.getState();
  assert.equal(state.events.length, 2);
  assert.deepEqual(state.events.map(({ provider, attribution, model }) => ({ provider, attribution, model })), [
    { provider: "cursor", attribution: "manual", model: null },
    { provider: "cursor", attribution: "manual", model: null }
  ]);
  assert.equal(state.events[0]?.sessionHash, state.events[1]?.sessionHash);
  assert.equal(state.rate.promptShownAt.length, 1);
  const persisted = await readFile(store.paths.stateFile, "utf8");
  assert.doesNotMatch(persisted, /private-command-argument|--resume|agent/);
});

test("run asks after every exit with a usable terminal but stays quiet during wrapper shutdown", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const cases: ReadonlyArray<{
    name: string;
    result: { exitCode: number; wrapperShuttingDown: boolean };
    shouldPrompt: boolean;
  }> = [
    { name: "clean-exit", result: { exitCode: 0, wrapperShuttingDown: false }, shouldPrompt: true },
    { name: "nonzero-exit", result: { exitCode: 23, wrapperShuttingDown: false }, shouldPrompt: true },
    { name: "posix-sigint", result: { exitCode: 130, wrapperShuttingDown: false }, shouldPrompt: true },
    { name: "windows-ctrl-c", result: { exitCode: 0xc000013a, wrapperShuttingDown: false }, shouldPrompt: true },
    { name: "windows-ctrl-break", result: { exitCode: 1, wrapperShuttingDown: false }, shouldPrompt: true },
    { name: "child-sigterm", result: { exitCode: 143, wrapperShuttingDown: false }, shouldPrompt: true },
    { name: "child-crash", result: { exitCode: 139, wrapperShuttingDown: false }, shouldPrompt: true },
    { name: "wrapper-sigterm", result: { exitCode: 143, wrapperShuttingDown: true }, shouldPrompt: false },
    { name: "wrapper-sighup", result: { exitCode: 129, wrapperShuttingDown: true }, shouldPrompt: false }
  ];

  for (const testCase of cases) {
    const configDir = join(directory, testCase.name, "config");
    const stateDir = join(directory, testCase.name, "state");
    const store = new LocalStore({
      configFile: join(configDir, "isaiokay", "config.json"),
      credentialFile: join(configDir, "isaiokay", "credential.json"),
      stateFile: join(stateDir, "isaiokay", "state.json")
    });
    await store.getConfig();
    await store.saveCredential({
      schemaVersion: 1,
      serverUrl: "https://isaiokay.com",
      accessToken: `iai_${"a".repeat(64)}`,
      expiresAt: now + 86_400_000
    });

    const ids = [
      wrapperId,
      "00000000-0000-4000-8000-000000000121",
      "00000000-0000-4000-8000-000000000122"
    ];
    let idIndex = 0;
    let currentTime = now - 21 * 60_000;
    let formOpened = false;
    const output = capturedIo("", {
      env: { TERM: "xterm-256color" },
      now: () => currentTime,
      fetch: async (input) => String(input).endsWith("/api/cli/items")
        ? Response.json({ items: [{ id: "1", slug: "gpt-5-6-sol", name: "GPT-5.6 Sol", providerName: "OpenAI", type: "model" }] })
        : Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 }),
      createId: () => ids[idIndex++]!,
      runCommand: async () => {
        currentTime = now;
        return testCase.result;
      },
      form: async () => { formOpened = true; return undefined; }
    }, true);

    assert.equal(await runCli([
      "run", "codex", "--config-dir", configDir, "--state-dir", stateDir
    ], output.io), testCase.result.exitCode, testCase.name);
    assert.equal(formOpened, testCase.shouldPrompt, testCase.name);
    assert.equal((await store.getState()).rate.promptShownAt.length, testCase.shouldPrompt ? 1 : 0, testCase.name);
  }
});

test("run accepts every supported harness through the same foreground contract", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const launched: string[] = [];

  for (const provider of PROVIDERS) {
    const output = capturedIo("", {
      env: { TERM: "xterm-256color" },
      runCommand: async (command, args, env) => {
        launched.push(env.ISAI_OKAY_FOREGROUND_PROVIDER ?? "missing");
        assert.equal(command, "test-harness");
        assert.deepEqual(args, ["--private-provider-argument"]);
        return { exitCode: 0, wrapperShuttingDown: false };
      },
      select: async () => { throw new Error("short sessions must not open a prompt"); },
      form: async () => ({})
    }, true);
    assert.equal(await runCli([
      "run", provider, "--command", "test-harness",
      "--config-dir", configDir, "--state-dir", stateDir,
      "--", "--private-provider-argument"
    ], output.io), 0);
    assert.equal(output.stdout(), "");
  }

  assert.deepEqual(launched, [...PROVIDERS]);
  const persisted = await readFile(join(stateDir, "isaiokay", "state.json"), "utf8");
  assert.doesNotMatch(persisted, /test-harness|private-provider-argument/);
});

test("a harness launch failure does not create a rateable session", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const output = capturedIo("", {
    env: { TERM: "xterm-256color" },
    runCommand: async () => { throw new Error("ENOENT"); },
    select: async () => { throw new Error("must not prompt"); },
    form: async () => ({})
  }, true);

  assert.equal(await runCli([
    "run", "codex", "--config-dir", configDir, "--state-dir", stateDir
  ], output.io), 127);
  assert.match(output.stderr(), /could not be started/);
  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  assert.deepEqual((await store.getState()).events, []);
});

test("a redirected shell wrapper passes the harness through without collecting", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  let launched = false;
  const output = capturedIo("", {
    env: { TERM: "xterm-256color", USER_SETTING: "preserved" },
    runCommand: async (command, args, env) => {
      launched = true;
      assert.equal(command, "codex");
      assert.deepEqual(args, ["--version"]);
      assert.equal(env.USER_SETTING, "preserved");
      assert.equal(env.ISAI_OKAY_FOREGROUND_SESSION, undefined);
      return { exitCode: 7, wrapperShuttingDown: false };
    }
  });

  assert.equal(await runCli([
    "run", "codex", "--config-dir", configDir, "--state-dir", stateDir, "--", "--version"
  ], output.io), 7);
  assert.equal(launched, true);
  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  assert.deepEqual((await store.getState()).events, []);
});

test("browser detection distinguishes desktops from headless and CI environments", () => {
  assert.equal(detectBrowserAvailability("linux", {}), false);
  assert.equal(detectBrowserAvailability("linux", { DISPLAY: ":0" }), true);
  assert.equal(detectBrowserAvailability("linux", { WAYLAND_DISPLAY: "wayland-0" }), true);
  assert.equal(detectBrowserAvailability("darwin", {}), true);
  assert.equal(detectBrowserAvailability("win32", {}), true);
  assert.equal(detectBrowserAvailability("darwin", { CI: "true" }), false);
  assert.equal(detectBrowserAvailability("linux", { DISPLAY: ":0", ISAI_OKAY_HEADLESS: "1" }), false);
  assert.equal(detectBrowserAvailability("linux", { ISAI_OKAY_BROWSER: "1" }), true);
});

test("shell command installs and removes transparent normal-command wrappers", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const env = { SHELL: "/bin/zsh" };

  const install = capturedIo("", { home, env });
  assert.equal(await runCli(["shell", "install"], install.io), 0);
  assert.deepEqual(JSON.parse(install.stdout()), {
    shell: "zsh",
    path: join(home, ".zshrc"),
    installed: true,
    changed: true,
    active: false,
    reloadCommand: `. '${join(home, ".zshrc")}'`
  });
  assert.match(await readFile(join(home, ".zshrc"), "utf8"), /isaiokay run codex/);

  const bashInstall = capturedIo("", { home, env });
  assert.equal(await runCli(["shell", "install", "bash"], bashInstall.io), 0);
  const bashStatus = capturedIo("", { home, env: { ...env, ISAI_OKAY_SHELL_ACTIVE: "zsh" } });
  assert.equal(await runCli(["shell", "status", "bash"], bashStatus.io), 0);
  assert.equal((JSON.parse(bashStatus.stdout()) as { active: boolean }).active, false);

  const uninstall = capturedIo("", { home, env });
  assert.equal(await runCli(["shell", "uninstall"], uninstall.io), 0);
  assert.equal((JSON.parse(uninstall.stdout()) as { installed: boolean }).installed, false);
  assert.equal(await readFile(join(home, ".zshrc"), "utf8"), "");
});

test("uninstall --all removes owned integrations and every registered shell wrapper", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const env = { SHELL: "/bin/zsh" };

  assert.equal(await runCli(["install", "codex"], capturedIo("", { home, env }).io), 0);
  assert.equal(await runCli(["install", "claude"], capturedIo("", { home, env }).io), 0);
  assert.equal(await runCli(["shell", "install"], capturedIo("", { home, env }).io), 0);
  assert.equal(await runCli(["shell", "install", "bash"], capturedIo("", { home, env }).io), 0);
  const powerShellProfile = join(home, "custom", "Profile.ps1");
  assert.equal(await runCli(["shell", "install", "powershell", "--profile", powerShellProfile], capturedIo("", { home, env }).io), 0);

  const uninstall = capturedIo("", { home, env });
  assert.equal(await runCli(["uninstall", "--all", "--purge"], uninstall.io), 0);
  const result = JSON.parse(uninstall.stdout()) as {
    results: Array<{ provider: string; removed: boolean }>;
    shells: Array<{ name: string; path: string; removed: boolean }>;
    purged: boolean;
    credentialRevocation: string;
    packageCommand: string;
  };
  assert.equal(result.results.length, PROVIDERS.length);
  assert.equal(result.results.every(({ removed }) => removed), true);
  assert.equal(result.shells.some(({ path, removed }) => path === join(home, ".zshrc") && removed), true);
  assert.equal(result.shells.some(({ path, removed }) => path === join(home, ".bashrc") && removed), true);
  assert.equal(result.shells.some(({ path, removed }) => path === powerShellProfile && removed), true);
  assert.equal(result.purged, true);
  assert.equal(result.credentialRevocation, "not_signed_in");
  assert.equal(result.packageCommand, "npm uninstall --global @isaiokay/cli");
  assert.doesNotMatch(await readFile(join(home, ".codex", "hooks.json"), "utf8"), /isaiokay/);
  assert.doesNotMatch(await readFile(join(home, ".claude", "settings.json"), "utf8"), /isaiokay/);
  assert.equal(await readFile(join(home, ".zshrc"), "utf8"), "");
  assert.equal(await readFile(join(home, ".bashrc"), "utf8"), "");
  assert.doesNotMatch(await readFile(powerShellProfile, "utf8"), /isaiokay/);
  await assert.rejects(readFile(join(home, ".config", "isaiokay", "config.json")), { code: "ENOENT" });
});

test("shell command supports PowerShell on Windows and an exact redirected profile", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const profile = join(home, "OneDrive - Example", "Documents", "PowerShell", "Profile.ps1");
  const latestProfile = join(home, "PortableHost", "Profile.ps1");
  const env = { POWERSHELL_DISTRIBUTION_CHANNEL: "MSI:Windows 11 Pro" };

  const install = capturedIo("", { home, env, platform: "win32" });
  assert.equal(await runCli(["shell", "install", "powershell", "--profile", profile], install.io), 0);
  assert.deepEqual(JSON.parse(install.stdout()), {
    shell: "powershell",
    path: profile,
    installed: true,
    changed: true,
    active: false,
    reloadCommand: `. '${profile}'`
  });
  assert.match(await readFile(profile, "utf8"), /function global:codex/);

  const secondInstall = capturedIo("", { home, env, platform: "win32" });
  assert.equal(await runCli(["shell", "install", "powershell", "--profile", latestProfile], secondInstall.io), 0);
  assert.match(await readFile(latestProfile, "utf8"), /function global:codex/);

  const status = capturedIo("", { home, env: { ...env, ISAI_OKAY_SHELL_ACTIVE: "powershell" }, platform: "win32" });
  assert.equal(await runCli(["shell", "status", "pwsh"], status.io), 0);
  assert.deepEqual(JSON.parse(status.stdout()), {
    shell: "powershell",
    path: latestProfile,
    installed: true,
    current: true,
    active: true,
    refreshCommand: null,
    reloadCommand: null
  });

  const invalid = capturedIo("", { home, env, platform: "win32" }, true);
  assert.equal(await runCli(["shell", "install", "zsh", "--profile", profile], invalid.io), 1);
  assert.match(invalid.stderr(), /PowerShell profile path/);

  const invalidPath = capturedIo("", { home, env, platform: "win32" }, true);
  assert.equal(await runCli(["shell", "install", "powershell", "--profile="], invalidPath.io), 1);
  assert.match(invalidPath.stderr(), /PowerShell profile path/);

  const relativePath = capturedIo("", { home, env, platform: "win32" }, true);
  assert.equal(await runCli(["shell", "install", "powershell", "--profile", "Profile.ps1"], relativePath.io), 1);
  assert.match(relativePath.stderr(), /PowerShell profile path/);
});

test("status surfaces shell inspection failures instead of claiming the wrapper is absent", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, ".zshrc"), "# >>> isaiokay automatic questionnaire >>>\n", "utf8");
  const env = { SHELL: "/bin/zsh", TERM: "xterm-256color", NO_COLOR: "1" };

  const human = capturedIo("", { home, env }, true);
  assert.equal(await runCli(["status"], human.io), 0);
  assert.match(human.stdout(), /Shell wrapper Check failed/);
  assert.match(human.stdout(), /isaiokay shell status/);
  assert.doesNotMatch(human.stdout(), /isaiokay shell install/);

  const json = capturedIo("", { home, env });
  assert.equal(await runCli(["doctor", "codex"], json.io), 0);
  assert.equal((JSON.parse(json.stdout()) as { shell: { inspectionFailed: boolean } }).shell.inspectionFailed, true);
});

test("doctor shows only actionable provider repairs and includes shell activation health", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const env = { SHELL: "/bin/zsh", TERM: "xterm-256color" };

  assert.equal(await runCli(["install", "codex"], capturedIo("", { home, env }).io), 0);
  const healthy = capturedIo("", { home, env }, true);
  assert.equal(await runCli(["doctor", "codex"], healthy.io), 0);
  assert.match(healthy.stdout(), /No provider repairs needed/);
  assert.match(healthy.stdout(), /Automatic questionnaire/);
  assert.match(healthy.stdout(), /isaiokay shell install/);
  assert.doesNotMatch(healthy.stdout(), /install <provider>/);

  await rm(join(home, ".codex", "hooks.json"));
  const broken = capturedIo("", { home, env }, true);
  assert.equal(await runCli(["doctor", "codex"], broken.io), 0);
  assert.match(broken.stdout(), /Repairs/);
  assert.match(broken.stdout(), /isaiokay install codex/);
});

test("config, pending, rate, and status commands remain local-only scaffolding", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];

  const install = capturedIo("", { home: directory });
  assert.equal(await runCli(["install", "gemini", ...base], install.io), 0);
  assert.match(install.stdout(), /"mode":"install"/);
  assert.match(install.stdout(), /"integration":\{"provider":"gemini","mode":"installed"/);
  assert.match(await readFile(join(directory, ".gemini", "settings.json"), "utf8"), /AfterAgent/);

  const uninstallGemini = capturedIo("", { home: directory });
  assert.equal(await runCli(["uninstall", "gemini", ...base], uninstallGemini.io), 0);
  assert.match(uninstallGemini.stdout(), /"registered":false/);

  const installCodex = capturedIo("", { home: directory });
  assert.equal(await runCli(["install", "codex", ...base], installCodex.io), 0);
  const codexInstall = JSON.parse(installCodex.stdout()) as { mode: string; registered: boolean; integration: { mode: string } };
  assert.equal(codexInstall.mode, "install");
  assert.equal(codexInstall.registered, true);
  assert.equal(codexInstall.integration.mode, "installed");

  const uninstallCodex = capturedIo("", { home: directory });
  assert.equal(await runCli(["uninstall", "codex", ...base], uninstallCodex.io), 0);
  assert.match(uninstallCodex.stdout(), /"registered":false/);

  const rate = capturedIo("");
  assert.equal(await runCli(["rate", "defer", "60", ...base], rate.io), 0);
  assert.match(rate.stdout(), /nextAllowedAt/);

  const status = capturedIo("");
  assert.equal(await runCli(["status", ...base], status.io), 0);
  const response = JSON.parse(status.stdout()) as { adapters: string[]; pendingCount: number };
  assert.deepEqual(response.adapters, []);
  assert.equal(response.pendingCount, 0);

  const never = capturedIo("");
  assert.equal(await runCli(["prompt", "never", ...base], never.io), 0);
  assert.deepEqual(JSON.parse(never.stdout()), { promptsDisabled: true });

  const promptStatus = capturedIo("");
  assert.equal(await runCli(["prompt", "status", ...base], promptStatus.io), 0);
  assert.match(promptStatus.stdout(), /"reason":"disabled"/);
});

test("status commands share reminder details and count sessions instead of lifecycle events", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  const now = 1_800_000_000_000;
  const sessionHash = "a".repeat(43);
  await store.recordEvents([
    { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000201", provider: "codex", attribution: "active_model", model: "gpt-5.6-sol", sessionHash, occurredAt: now - 21 * 60_000, recordedAt: now },
    { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000202", provider: "codex", attribution: "active_model", model: "gpt-5.6-sol", sessionHash, occurredAt: now, recordedAt: now }
  ]);

  const statusOutput = capturedIo("", { now: () => now });
  assert.equal(await runCli(["status", ...base], statusOutput.io), 0);
  const status = JSON.parse(statusOutput.stdout()) as {
    eventCount: number;
    sessionCount: number;
    pendingCount: number;
    pendingSessionCount: number;
    prompt: Record<string, unknown>;
  };
  assert.equal(status.eventCount, 2);
  assert.equal(status.sessionCount, 1);
  assert.equal(status.pendingCount, 2);
  assert.equal(status.pendingSessionCount, 1);

  const rateOutput = capturedIo("", { now: () => now });
  const promptOutput = capturedIo("", { now: () => now });
  assert.equal(await runCli(["rate", "show", ...base], rateOutput.io), 0);
  assert.equal(await runCli(["prompt", "status", ...base], promptOutput.io), 0);
  const rate = JSON.parse(rateOutput.stdout()) as Record<string, unknown>;
  const prompt = JSON.parse(promptOutput.stdout()) as Record<string, unknown>;
  for (const key of ["eligible", "reason", "eventId", "experiencedMs", "rateableExperiencedMs", "pendingSessionCountToday", "requiredExperienceMs", "remainingExperienceMs", "nextAllowedAt", "lastPromptAt"]) {
    assert.deepEqual(rate[key], status.prompt[key], key);
    assert.deepEqual(prompt[key], status.prompt[key], key);
  }

  await store.clearPending();
  const noPending = capturedIo("", { now: () => now }, true);
  assert.equal(await runCli(["prompt", "status", ...base], noPending.io), 0);
  assert.match(noPending.stdout(), /No eligible session today/);
  assert.doesNotMatch(noPending.stdout(), /Needs 1 more minute/);
});

test("prompt reservations survive only once an interactive form can actually open", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  const store = new LocalStore({
    configFile: join(configDir, "isaiokay", "config.json"),
    credentialFile: join(configDir, "isaiokay", "credential.json"),
    stateFile: join(stateDir, "isaiokay", "state.json")
  });
  const now = 1_800_000_000_000;
  const sessionHash = "a".repeat(43);
  await store.recordEvents([
    { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000211", provider: "codex", attribution: "active_model", model: "gpt-5.6-sol", sessionHash, occurredAt: now - 21 * 60_000, recordedAt: now },
    { schemaVersion: 1, id: "00000000-0000-4000-8000-000000000212", provider: "codex", attribution: "active_model", model: "gpt-5.6-sol", sessionHash, occurredAt: now, recordedAt: now }
  ]);

  const signedOut = capturedIo("", { now: () => now, form: async () => ({}) }, true);
  assert.equal(await runCli(["prompt", ...base], signedOut.io), 1);
  assert.deepEqual((await store.getState()).rate.promptShownAt, []);

  await store.saveCredential({
    schemaVersion: 1,
    serverUrl: "https://isaiokay.com",
    accessToken: `iai_${"a".repeat(64)}`,
    expiresAt: now + 86_400_000
  });
  const catalogFailure = capturedIo("", {
    now: () => now,
    form: async () => { throw new Error("form must not open"); },
    fetch: async () => Response.json({ error: { code: "catalog_unavailable", message: "Unavailable" } }, { status: 503 })
  }, true);
  assert.equal(await runCli(["prompt", ...base], catalogFailure.io), 1);
  assert.deepEqual((await store.getState()).rate.promptShownAt, []);

  const formFailure = capturedIo("", {
    now: () => now,
    form: async () => { throw new Error("terminal unavailable"); },
    fetch: async () => Response.json({ items: [{ id: "1", slug: "gpt-5-6-sol", name: "GPT-5.6 Sol", providerName: "OpenAI", type: "model" }] })
  }, true);
  assert.equal(await runCli(["prompt", ...base], formFailure.io), 1);
  assert.deepEqual((await store.getState()).rate.promptShownAt, []);

  const redirected = capturedIo("", { now: () => now });
  assert.equal(await runCli(["prompt", ...base], redirected.io), 0);
  assert.equal((JSON.parse(redirected.stdout()) as { eligible: boolean }).eligible, true);
  assert.deepEqual((await store.getState()).rate.promptShownAt, []);
});

test("login stores only the scoped credential and rate explicitly submits minimized feedback", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  const privateSession = "provider-session-that-must-not-leave-the-hook";
  const privatePrompt = "private source code request";
  const requests: Array<{ url: string; body: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, body: typeof init?.body === "string" ? init.body : null });
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64),
      userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    if (url.endsWith("/api/cli/device/approve")) return Response.json({ ok: true, clientName: "Remote CLI" });
    if (url.endsWith("/api/cli/feedback")) return Response.json({ accepted: true, reportId: "report-id" }, { status: 201 });
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };

  const opened: string[] = [];
  const login = capturedIo("", { fetch: fetcher, openUrl: async (url) => { opened.push(url); }, browserAvailable: false });
  assert.equal(await runCli(["login", "--server", "https://isaiokay.com", ...base], login.io), 0);
  assert.match(login.stdout(), /"authenticated":true/);
  assert.match(login.stdout(), /"mode":"headless"/);
  assert.match(login.stdout(), /"headlessCommand":"isaiokay authorize ABCD-EFGH"/);
  assert.deepEqual(opened, []);
  const credential = await readFile(join(configDir, "isaiokay", "credential.json"), "utf8");
  assert.equal(credential.includes("d".repeat(64)), false);

  const authorize = capturedIo("", { fetch: fetcher });
  assert.equal(await runCli(["authorize", "WXYZ-2345", ...base], authorize.io), 0);
  assert.match(authorize.stdout(), /"approved":true/);
  assert.equal(requests.some((request) => request.url.endsWith("/api/cli/device/approve") && request.body === '{"userCode":"WXYZ-2345"}'), true);

  const hook = capturedIo(JSON.stringify({
    hook_event_name: "Stop",
    model: "gpt-5",
    session_id: privateSession,
    prompt: privatePrompt
  }));
  assert.equal(await runCli(["hook", "--provider", "codex", ...base], hook.io), 0);

  const rating = capturedIo("", { fetch: fetcher });
  assert.equal(await runCli([
    "rate", "submit", "--result-quality", "2", "--usage-efficiency", "3", "--item", "gpt-5", ...base
  ], rating.io), 0);
  const submission = requests.find((request) => request.url.endsWith("/api/cli/feedback"))?.body ?? "";
  assert.equal(submission.includes(privateSession), false);
  assert.equal(submission.includes(privatePrompt), false);
  assert.match(submission, /"rawModelLabel":"gpt-5"/);
  assert.match(submission, /"resultQualityRating":2/);
  assert.match(submission, /"usageEfficiencyRating":3/);
});

test("login guides terminal users while preserving explicit JSON and accessible plain output", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64),
      userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) {
      return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    }
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };
  const base = ["--config-dir", join(directory, "config"), "--state-dir", join(directory, "state")];

  const terminal = capturedIo("", {
    fetch: fetcher,
    browserAvailable: true,
    openUrl: async () => {},
    env: { TERM: "xterm-256color" }
  }, true);
  assert.equal(await runCli(["login", ...base], terminal.io), 0);
  assert.match(terminal.stdout(), /IsAIokay\.com/);
  assert.match(terminal.stdout(), /Browser opened/);
  assert.match(terminal.stdout(), /One-time code/);
  assert.match(terminal.stdout(), /Waiting for approval/);
  assert.match(terminal.stdout(), /You're signed in/);
  assert.match(terminal.stdout(), /\u001b\[/);
  assert.doesNotMatch(terminal.stdout(), /"action":"authorize"/);

  const plain = capturedIo("", {
    fetch: fetcher,
    browserAvailable: false,
    env: { TERM: "xterm-256color", NO_COLOR: "1" }
  }, true);
  assert.equal(await runCli(["login", "--headless", ...base], plain.io), 0);
  assert.match(plain.stdout(), /No browser will be opened/);
  assert.match(plain.stdout(), /isaiokay authorize ABCD-EFGH/);
  assert.doesNotMatch(plain.stdout(), /\u001b\[/);

  const json = capturedIo("", {
    fetch: fetcher,
    browserAvailable: false,
    env: { TERM: "xterm-256color" }
  }, true);
  assert.equal(await runCli(["login", "--json", ...base], json.io), 0);
  const lines = json.stdout().trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]?.action, "authorize");
  assert.equal(lines[1]?.authenticated, true);
  assert.doesNotMatch(json.stdout(), /\u001b\[/);
});

test("login detects popular CLIs and installs only explicitly selected integrations", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };
  const detectedCommands: string[] = [];
  const login = capturedIo("", {
    fetch: fetcher,
    home: directory,
    browserAvailable: false,
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
    commandExists: async (command) => {
      detectedCommands.push(command);
      return command === "codex" || command === "claude";
    },
    selectMany: async (question, choices, options) => {
      assert.equal(question, "Install integrations (optional)");
      assert.deepEqual(choices.map((choice) => choice.value), ["codex", "claude"]);
      assert.deepEqual(options?.initialValues, ["codex", "claude"]);
      return ["codex", "claude"];
    },
    select: async (question) => {
      assert.equal(question, "Open eligible questionnaires automatically?");
      return "enable";
    }
  }, true);

  assert.equal(await runCli(["login", "--headless"], login.io), 0);
  assert.deepEqual(detectedCommands, ["codex", "claude", "agent", "opencode", "gemini", "copilot", "amp", "grok"]);
  assert.match(login.stdout(), /Detected coding CLIs/);
  assert.match(login.stdout(), /doctor/);
  assert.match(await readFile(join(directory, ".codex", "hooks.json"), "utf8"), /isaiokay hook --provider codex/);
  assert.match(await readFile(join(directory, ".claude", "settings.json"), "utf8"), /isaiokay hook --provider claude/);
  assert.match(await readFile(join(directory, ".zshrc"), "utf8"), /isaiokay run codex/);
  assert.match(login.stdout(), /Automatic questionnaires installed/);
  assert.match(login.stdout(), /activate it in this terminal/);
  const config = JSON.parse(await readFile(join(directory, ".config", "isaiokay", "config.json"), "utf8")) as { adapters: Record<string, unknown>; shellIntegrations: unknown[] };
  assert.deepEqual(Object.keys(config.adapters).sort(), ["claude", "codex"]);
  assert.equal(config.shellIntegrations.length, 1);
});

test("a fresh bare command runs complete onboarding once", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };
  const firstRun = capturedIo("", {
    fetch: fetcher,
    home,
    browserAvailable: false,
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
    commandExists: async (command) => command === "codex",
    selectMany: async () => ["codex"],
    select: async () => "enable",
    form: async () => ({})
  }, true);

  assert.equal(await runCli([], firstRun.io), 0);
  assert.match(firstRun.stdout(), /IsAIokay\.com/);
  assert.match(firstRun.stdout(), /Setup complete/);
  assert.match(await readFile(join(home, ".codex", "hooks.json"), "utf8"), /isaiokay hook --provider codex/);
  assert.match(await readFile(join(home, ".zshrc"), "utf8"), /isaiokay run codex/);
  const config = JSON.parse(await readFile(join(home, ".config", "isaiokay", "config.json"), "utf8")) as { onboardingCompletedAt: number | null };
  assert.equal(config.onboardingCompletedAt, 1_700_000_000_000);

  let fetchedAgain = false;
  const laterRun = capturedIo("", {
    fetch: async () => { fetchedAgain = true; throw new Error("must not fetch"); },
    home,
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
    commandExists: async () => false,
    form: async () => ({})
  }, true);
  assert.equal(await runCli([], laterRun.io), 0);
  assert.equal(fetchedAgain, false);
  assert.match(laterRun.stdout(), /Signed in/);
  assert.doesNotMatch(laterRun.stdout(), /Let’s connect/);
});

test("cancelling first-run setup leaves onboarding incomplete and allows a retry", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };
  const cancelled = capturedIo("", {
    fetch: fetcher,
    home,
    browserAvailable: false,
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
    commandExists: async (command) => command === "codex",
    selectMany: async () => undefined,
    select: async () => "enable",
    form: async () => ({})
  }, true);

  assert.equal(await runCli([], cancelled.io), 1);
  assert.match(cancelled.stdout(), /Setup paused/);
  const store = new LocalStore(resolveStoragePaths({ home, env: {} }));
  assert.equal((await store.getConfig()).onboardingCompletedAt, null);
  assert.ok(await store.getCredential());

  let fetchedAgain = false;
  const retry = capturedIo("", {
    fetch: async () => { fetchedAgain = true; throw new Error("must not fetch"); },
    home,
    env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
    commandExists: async () => false,
    selectMany: async () => [],
    select: async () => "later",
    form: async () => ({})
  }, true);
  assert.equal(await runCli([], retry.io), 0);
  assert.equal(fetchedAgain, false);
  assert.match(retry.stdout(), /Already signed in/);
  assert.equal((await store.getConfig()).onboardingCompletedAt, 1_700_000_000_000);
});

test("an empty interactive command opens one two-rating screen when a signed-in session is pending", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const feedbackBodies: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    if (url.endsWith("/api/cli/items")) return Response.json({ items: [
      { id: "1", slug: "gpt-5-6-sol", name: "GPT-5.6 Sol", providerName: "OpenAI", type: "model" }
    ] });
    if (url.endsWith("/api/cli/feedback")) {
      feedbackBodies.push(typeof init?.body === "string" ? init.body : "");
      return Response.json({ accepted: true, reportId: "report-id" }, { status: 201 });
    }
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };

  const login = capturedIo("", { fetch: fetcher, home: directory });
  assert.equal(await runCli(["login", "--no-open"], login.io), 0);
  await new LocalStore(resolveStoragePaths({ home: directory, env: {} })).completeOnboarding();
  const hook = capturedIo(JSON.stringify({ event: "model.active", model: "gpt-5.6-sol", session_id: "private-session" }), { home: directory });
  assert.equal(await runCli(["hook", "--provider", "codex"], hook.io), 0);

  const screens: string[] = [];
  let typedPromptCalled = false;
  const rating = capturedIo("", {
    fetch: fetcher,
    home: directory,
    env: { TERM: "xterm-256color" },
    prompt: async () => { typedPromptCalled = true; return "must-not-be-used"; },
    form: async (title, fields) => {
      screens.push(title);
      assert.equal(title, "Quick check-in");
      assert.deepEqual(fields.map((field) => field.name), ["item", "resultQuality", "usageEfficiency"]);
      assert.equal(fields[0]?.initialValue, "gpt-5-6-sol");
      return { item: "gpt-5-6-sol", resultQuality: "5", usageEfficiency: "4" };
    }
  }, true);
  assert.equal(await runCli([], rating.io), 0);
  assert.deepEqual(screens, ["Quick check-in"]);
  assert.equal(typedPromptCalled, false);
  assert.match(rating.stdout(), /Rating submitted/);
  assert.equal(feedbackBodies.length, 1);
  assert.match(feedbackBodies[0] ?? "", /"resultQualityRating":5/);
  assert.match(feedbackBodies[0] ?? "", /"usageEfficiencyRating":4/);
  assert.match(feedbackBodies[0] ?? "", /"confirmedItemSlug":"gpt-5-6-sol"/);
});

test("Claude's SessionStart model is preselected from an Anthropic-only catalog", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const store = new LocalStore(resolveStoragePaths({ home: directory, env: {} }));
  await store.saveCredential({
    schemaVersion: 1,
    serverUrl: "https://isaiokay.com",
    accessToken: `iai_${"a".repeat(64)}`,
    expiresAt: now + 60_000
  });

  for (const [hookEventName, occurredAt] of [
    ["SessionStart", now - 21 * 60_000],
    ["Stop", now]
  ] as const) {
    const hook = capturedIo(JSON.stringify({
      hook_event_name: hookEventName,
      model: hookEventName === "SessionStart" ? "claude-sonnet-5" : undefined,
      session_id: "private-claude-session"
    }), { home: directory, now: () => occurredAt });
    assert.equal(await runCli(["hook", "--provider", "claude"], hook.io), 0);
  }

  let feedbackBody = "";
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/cli/items")) return Response.json({ items: [
      { id: "1", slug: "claude-fable-5", name: "Claude Fable 5", providerName: "Anthropic", type: "model" },
      { id: "2", slug: "claude-opus-5", name: "Claude Opus 5", providerName: "Anthropic", type: "model" },
      { id: "3", slug: "claude-sonnet-5", name: "Claude Sonnet 5", providerName: "Anthropic", type: "model" },
      { id: "4", slug: "gpt-5-6-sol", name: "GPT-5.6 Sol", providerName: "OpenAI", type: "model" },
      { id: "5", slug: "claude-code", name: "Claude Code", providerName: "Anthropic", type: "agent" }
    ] });
    if (url.endsWith("/api/cli/feedback")) {
      feedbackBody = typeof init?.body === "string" ? init.body : "";
      return Response.json({ accepted: true, reportId: "report-id" }, { status: 201 });
    }
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };
  const rating = capturedIo("", {
    fetch: fetcher,
    home: directory,
    now: () => now,
    env: { TERM: "xterm-256color" },
    form: async (title, fields) => {
      assert.equal(title, "Quick check-in");
      assert.deepEqual(fields.map((field) => field.name), ["item", "resultQuality", "usageEfficiency"]);
      const modelField = fields[0];
      assert.equal(modelField?.initialValue, "claude-sonnet-5");
      assert.deepEqual(modelField?.choices.map((choice) => choice.value), [
        "claude-fable-5", "claude-opus-5", "claude-sonnet-5"
      ]);
      return { item: "claude-sonnet-5", resultQuality: "5", usageEfficiency: "4" };
    }
  }, true);

  assert.equal(await runCli(["rate", "submit"], rating.io), 0);
  assert.match(feedbackBody, /"rawModelLabel":"claude-sonnet-5"/);
  assert.match(feedbackBody, /"confirmedItemSlug":"claude-sonnet-5"/);
  assert.match(feedbackBody, /"attribution":"user_confirmed"/);
});

test("Esc skips a direct check-in until the next local day", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const store = new LocalStore(resolveStoragePaths({ home: directory, env: {} }));
  await store.saveCredential({
    schemaVersion: 1,
    serverUrl: "https://isaiokay.com",
    accessToken: `iai_${"a".repeat(64)}`,
    expiresAt: now + 86_400_000
  });
  const hook = capturedIo(JSON.stringify({
    event: "model.active",
    model: "gpt-5.6-sol",
    session_id: "private-session"
  }), { home: directory, now: () => now });
  assert.equal(await runCli(["hook", "--provider", "codex"], hook.io), 0);

  let submitted = false;
  const rating = capturedIo("", {
    home: directory,
    now: () => now,
    env: { TERM: "xterm-256color" },
    fetch: async (input) => {
      if (String(input).endsWith("/api/cli/items")) {
        return Response.json({ items: [{ id: "1", slug: "gpt-5-6-sol", name: "GPT-5.6 Sol", providerName: "OpenAI", type: "model" }] });
      }
      submitted = true;
      return Response.json({ accepted: true }, { status: 201 });
    },
    form: async () => undefined
  }, true);

  assert.equal(await runCli(["rate"], rating.io), 0);
  assert.equal(submitted, false);
  assert.match(rating.stdout(), /Skipped for today/);
  const state = await store.getState();
  assert.ok(state.rate.nextAllowedAt !== null && state.rate.nextAllowedAt > now);
  assert.equal(decidePrompt(state, now).reason, "cooldown");
});

test("JSON rating output is one complete document", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  const store = new LocalStore(resolveStoragePaths({ home: directory, env: {} }));
  await store.saveCredential({
    schemaVersion: 1,
    serverUrl: "https://isaiokay.com",
    accessToken: `iai_${"a".repeat(64)}`,
    expiresAt: now + 86_400_000
  });
  const hook = capturedIo(JSON.stringify({
    event: "model.active",
    model: "gpt-5.6-sol",
    session_id: "private-session"
  }), { home: directory, now: () => now });
  assert.equal(await runCli(["hook", "--provider", "codex"], hook.io), 0);

  const rating = capturedIo("", {
    home: directory,
    now: () => now,
    fetch: async () => Response.json({ accepted: true, reportId: "report-id" }, { status: 201 })
  });
  assert.equal(await runCli([
    "rate", "submit", "--json", "--result-quality", "5", "--usage-efficiency", "4", "--item", "gpt-5-6-sol"
  ], rating.io), 0);
  const lines = rating.stdout().trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { submitted: true, result: { accepted: true, reportId: "report-id" } });
});

test("an empty interactive command shows status when there is nothing to rate", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const store = new LocalStore({
    configFile: join(directory, ".config", "isaiokay", "config.json"),
    credentialFile: join(directory, ".config", "isaiokay", "credential.json"),
    stateFile: join(directory, ".local", "state", "isaiokay", "state.json")
  });
  await store.completeOnboarding();
  let formCalled = false;
  const output = capturedIo("", {
    home: directory,
    env: { TERM: "xterm-256color" },
    commandExists: async (command) => command === "codex" || command === "claude",
    form: async () => { formCalled = true; return {}; }
  }, true);
  assert.equal(await runCli([], output.io), 0);
  assert.equal(formCalled, false);
  assert.match(output.stdout(), /Not signed in/);
  assert.match(output.stdout(), /No sessions|0 recorded/);
  assert.match(output.stdout(), /isaiokay login/);
  assert.match(output.stdout(), /Detected\s+Codex, Claude Code/);
  assert.match(output.stdout(), /isaiokay install --all/);
  assert.match(output.stdout(), /isaiokay install codex/);
  assert.match(output.stdout(), /isaiokay install claude/);
});

test("command help is side-effect free and unknown options fail clearly", async () => {
  let requested = false;
  const helpOutput = capturedIo("", { fetch: async () => { requested = true; throw new Error("must not fetch"); } }, true);
  assert.equal(await runCli(["login", "--help"], helpOutput.io), 0);
  assert.equal(requested, false);
  assert.match(helpOutput.stdout(), /Sign in with a short-lived browser code/);

  const invalid = capturedIo("", {}, true);
  assert.equal(await runCli(["login", "--hedless"], invalid.io), 1);
  assert.match(invalid.stderr(), /Unknown option: --hedless/);
});

test("setup refuses noninteractive execution before starting authentication", async () => {
  let requested = false;
  const output = capturedIo("", {
    fetch: async () => { requested = true; throw new Error("must not fetch"); }
  });

  assert.equal(await runCli(["setup", "--json"], output.io), 1);
  assert.equal(requested, false);
  assert.match(output.stderr(), /interactive_setup_required/);
});

test("install --all installs every detected automatic integration in one command", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = capturedIo("", {
    home: directory,
    commandExists: async (command) => command === "codex" || command === "claude" || command === "opencode"
  });

  assert.equal(await runCli(["install", "--all"], output.io), 0);
  const result = JSON.parse(output.stdout()) as { detected: string[]; results: Array<{ provider: string; installed: boolean }> };
  assert.deepEqual(result.detected, ["codex", "claude", "opencode"]);
  assert.deepEqual(result.results.map(({ provider, installed }) => ({ provider, installed })), [
    { provider: "codex", installed: true },
    { provider: "claude", installed: true },
    { provider: "opencode", installed: true }
  ]);
  assert.match(await readFile(join(directory, ".codex", "hooks.json"), "utf8"), /isaiokay hook --provider codex/);
  assert.match(await readFile(join(directory, ".claude", "settings.json"), "utf8"), /isaiokay hook --provider claude/);
  assert.match(await readFile(join(directory, ".config", "opencode", "plugins", "isaiokay.js"), "utf8"), /"isaiokay","hook","--provider","opencode"/);
});

test("one-shot runners refuse integration mutation and point to persistent installs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = capturedIo("", {
    home: directory,
    env: { npm_lifecycle_event: "npx", TERM: "xterm-256color" },
    commandExists: async () => true
  }, true);

  assert.equal(await runCli(["install", "--all"], output.io), 1);
  assert.match(output.stderr(), /Install the CLI persistently/);
  assert.match(output.stderr(), /npm install --global @isaiokay\/cli/);
  assert.match(output.stderr(), /pnpm add --global @isaiokay\/cli/);
  assert.match(output.stderr(), /bun add --global @isaiokay\/cli/);
  await assert.rejects(readFile(join(directory, ".codex", "hooks.json"), "utf8"));
});

test("one-shot login saves authentication but skips the integration selector", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };
  let selectionOpened = false;
  const output = capturedIo("", {
    fetch: fetcher,
    home: directory,
    browserAvailable: false,
    env: { npm_lifecycle_event: "bunx", TERM: "xterm-256color" },
    commandExists: async () => true,
    selectMany: async () => { selectionOpened = true; return ["codex"]; }
  }, true);

  assert.equal(await runCli(["login", "--headless"], output.io), 0);
  assert.equal(selectionOpened, false);
  assert.match(output.stdout(), /Signed in through bunx; integration setup was skipped/);
  assert.match(output.stdout(), /isaiokay setup/);
  const credential = await readFile(join(directory, ".config", "isaiokay", "credential.json"), "utf8");
  assert.match(credential, /iai_/);
});

test("one-shot setup reports that onboarding is incomplete after saving authentication", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };
  let selectionOpened = false;
  const output = capturedIo("", {
    fetch: fetcher,
    home: directory,
    browserAvailable: false,
    env: { npm_lifecycle_event: "npx", TERM: "xterm-256color" },
    commandExists: async () => true,
    selectMany: async () => { selectionOpened = true; return ["codex"]; },
    select: async () => "enable"
  }, true);

  assert.equal(await runCli(["setup", "--headless"], output.io), 1);
  assert.equal(selectionOpened, false);
  assert.match(output.stdout(), /integration setup was skipped/);
  assert.match(await readFile(join(directory, ".config", "isaiokay", "credential.json"), "utf8"), /iai_/);
  await assert.rejects(readFile(join(directory, ".config", "isaiokay", "config.json"), "utf8"));
});

test("a lost submission response retries with the same client event id", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  const feedbackBodies: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH",
      verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH",
      expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) {
      return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    }
    if (url.endsWith("/api/cli/feedback")) {
      feedbackBodies.push(typeof init?.body === "string" ? init.body : "");
      if (feedbackBodies.length === 1) throw new Error("response lost after acceptance");
      return Response.json({ accepted: true, idempotent: true, reportId: "report-id" }, { status: 200 });
    }
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };

  const login = capturedIo("", { fetch: fetcher });
  assert.equal(await runCli(["login", "--no-open", "--server", "https://isaiokay.com", ...base], login.io), 0);
  const hook = capturedIo(JSON.stringify({
    event: "model.active", model: "gpt-5.6-sol", session_id: "stable-private-session"
  }));
  assert.equal(await runCli(["hook", "--provider", "codex", ...base], hook.io), 0);

  const ratingArgs = [
    "rate", "submit", "--result-quality", "4", "--usage-efficiency", "4", "--item", "gpt-5-6-sol", ...base
  ];
  const first = capturedIo("", { fetch: fetcher });
  assert.equal(await runCli(ratingArgs, first.io), 1);
  const retry = capturedIo("", { fetch: fetcher });
  assert.equal(await runCli(ratingArgs, retry.io), 0);

  const firstBody = JSON.parse(feedbackBodies[0] ?? "{}") as { clientEventId?: string };
  const retryBody = JSON.parse(feedbackBodies[1] ?? "{}") as { clientEventId?: string };
  assert.match(firstBody.clientEventId ?? "", /^[0-9a-f-]{36}$/i);
  assert.equal(retryBody.clientEventId, firstBody.clientEventId);
});

test("rate opens a browser challenge, polls the scoped status, and retries with its one-time proof", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "isaiokay-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const configDir = join(directory, "config");
  const stateDir = join(directory, "state");
  const base = ["--config-dir", configDir, "--state-dir", stateDir];
  let now = 1_700_000_000_000;
  const verificationUrl = "https://isaiokay.com/cli/verify/11111111-1111-4111-8111-111111111111";
  const challengeId = "11111111-1111-4111-8111-111111111111";
  const proof = "b".repeat(64);
  const opened: string[] = [];
  const feedbackBodies: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/cli/device/start")) return Response.json({
      deviceCode: "d".repeat(64), userCode: "ABCD-EFGH", verificationUriComplete: "https://isaiokay.com/cli/authorize?user_code=ABCD-EFGH", expiresIn: 600, interval: 1
    }, { status: 201 });
    if (url.endsWith("/api/cli/device/token")) return Response.json({ accessToken: `iai_${"a".repeat(64)}`, expiresIn: 3600 });
    if (url.endsWith(`/api/cli/challenges/${challengeId}`)) {
      return Response.json({ id: challengeId, status: "verified", expiresAt: now + 60_000, challengeProof: proof });
    }
    if (url.endsWith("/api/cli/feedback")) {
      const body = typeof init?.body === "string" ? init.body : "";
      feedbackBodies.push(body);
      if (feedbackBodies.length === 1) {
        return Response.json({
          error: {
            code: "cli_verification_required",
            message: "Browser verification is required.",
            details: { challengeId, verificationUrl, expiresAt: new Date(now + 60_000).toISOString() }
          }
        }, { status: 428 });
      }
      return Response.json({ accepted: true, reportId: "report-id" }, { status: 201 });
    }
    return Response.json({ error: { code: "unexpected", message: "Unexpected request" } }, { status: 500 });
  };

  const login = capturedIo("", { fetch: fetcher, now: () => now });
  assert.equal(await runCli(["login", "--no-open", "--server", "https://isaiokay.com", ...base], login.io), 0);
  const hook = capturedIo(JSON.stringify({ hook_event_name: "Stop", model: "gpt-5", session_id: "private-session" }), { now: () => now });
  assert.equal(await runCli(["hook", "--provider", "codex", ...base], hook.io), 0);

  const rating = capturedIo("", {
    fetch: fetcher,
    now: () => now,
    openUrl: async (url) => { opened.push(url); },
    sleep: async (milliseconds) => { now += milliseconds; }
  });
  assert.equal(await runCli([
    "rate", "submit", "--result-quality", "4", "--usage-efficiency", "4", "--item", "gpt-5", ...base
  ], rating.io), 0);

  assert.deepEqual(opened, [verificationUrl]);
  assert.equal(feedbackBodies.length, 2);
  assert.equal(feedbackBodies[0]?.includes(proof), false);
  assert.match(feedbackBodies[1] ?? "", new RegExp(`"challengeId":"${challengeId}"`));
  assert.match(feedbackBodies[1] ?? "", new RegExp(`"challengeProof":"${proof}"`));
  assert.match(rating.stdout(), /"verificationRequired":true/);
  assert.match(rating.stdout(), /"submitted":true/);
});
