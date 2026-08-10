import type { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { doctorAdapter, installAdapter, uninstallAdapter } from "./adapters.js";
import { ApiError, approveDeviceLogin, getAllowance, getCliTurnstileChallenge, getTrackedItems, isUuid, normalizeSameOriginWebUrl, pollDeviceLogin, revokeCredential, startDeviceLogin, submitFeedback } from "./api.js";
import { normalizeProviderEvent } from "./normalizers.js";
import { decidePrompt } from "./prompt-policy.js";
import { createEventId, MAX_INPUT_BYTES, safeEventSummary, sessionHash as hashSession } from "./privacy.js";
import { LocalStore, resolveStoragePaths } from "./storage.js";
import { defaultHarnessCommand, detectShell, installShellIntegration, renderShellIntegration, shellIntegrationInstalled, shellIntegrationPath, SUPPORTED_SHELLS, uninstallShellIntegration, type SupportedShell } from "./shell-integration.js";
import { summarizeSession } from "./session-summary.js";
import type { TerminalChoice, TerminalFormField } from "./terminal.js";
import { PROVIDERS, type ApiTrackedItem, type CliCredential, type Provider, type StoredEvent } from "./types.js";
import { detectOneShotRunner, type OneShotRunner } from "./executable.js";

const HOOK_INPUT_TIMEOUT_MS = 1_500;

export interface CliIo {
  stdin: AsyncIterable<string | Uint8Array> & Partial<{ destroy: () => void }>;
  stdout: Pick<Writable, "write"> & Partial<{ isTTY: boolean }>;
  stderr: Pick<Writable, "write"> & Partial<{ isTTY: boolean }>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  browserAvailable?: boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  prompt?: (question: string) => Promise<string>;
  commandExists?: (command: string) => Promise<boolean>;
  select?: (question: string, choices: readonly TerminalChoice[], options?: { initialValue?: string; color?: boolean }) => Promise<string | undefined>;
  selectMany?: (question: string, choices: readonly TerminalChoice[], options?: { initialValues?: string[]; color?: boolean; maxSelections?: number }) => Promise<string[] | undefined>;
  form?: (title: string, fields: readonly TerminalFormField[], options?: { color?: boolean; submitLabel?: string; cancelLabel?: string }) => Promise<Record<string, string> | undefined>;
  runCommand?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ exitCode: number; signal: NodeJS.Signals | null }>;
  createId?: () => string;
}

interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  passthrough: string[];
  flags: Map<string, string | true>;
}

const packageMetadata = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as unknown;
const CLI_VERSION = typeof packageMetadata === "object" && packageMetadata !== null && "version" in packageMetadata &&
  typeof packageMetadata.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version)
  ? packageMetadata.version
  : "unknown";
const FOREGROUND_SESSION_ENV = "ISAI_OKAY_FOREGROUND_SESSION";
const FOREGROUND_PROVIDER_ENV = "ISAI_OKAY_FOREGROUND_PROVIDER";

const BOOLEAN_FLAGS = new Set([
  "all", "headless", "help", "json", "local", "no-color", "no-input", "no-open", "no-setup", "quiet", "verbose"
]);

const parseArgs = (argv: string[]): ParsedArgs => {
  const [command, ...tail] = argv;
  const positionals: string[] = [];
  const passthrough: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < tail.length; index += 1) {
    const rawToken = tail[index];
    if (rawToken === "--") {
      passthrough.push(...tail.slice(index + 1));
      break;
    }
    const token = rawToken === "-h" ? "--help" : rawToken;
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey) continue;
    if (inlineValue !== undefined) {
      flags.set(rawKey, inlineValue);
      continue;
    }
    if (BOOLEAN_FLAGS.has(rawKey)) {
      flags.set(rawKey, true);
      continue;
    }
    const next = tail[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(rawKey, next);
      index += 1;
    } else {
      flags.set(rawKey, true);
    }
  }
  return { command, positionals, passthrough, flags };
};

const flagText = (flags: Map<string, string | true>, name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

const parseProvider = (value: string | undefined): Provider | null =>
  value !== undefined && (PROVIDERS as readonly string[]).includes(value) ? value as Provider : null;

const writeJson = (io: CliIo, body: unknown): void => {
  io.stdout.write(`${JSON.stringify(body)}\n`);
};

const writeError = (io: CliIo, code: string): void => {
  io.stderr.write(`isaiokay: ${code}\n`);
};

const loginUsesHumanOutput = (parsed: ParsedArgs, io: CliIo): boolean =>
  !parsed.flags.has("json") && io.stdout.isTTY === true;

const loginUsesColor = (parsed: ParsedArgs, io: CliIo): boolean => {
  if (!loginUsesHumanOutput(parsed, io) || parsed.flags.has("no-color")) return false;
  if (io.env?.NO_COLOR !== undefined && io.env.NO_COLOR !== "") return false;
  if (io.env?.TERM === "dumb" || io.env?.FORCE_COLOR === "0") return false;
  return true;
};

const loginStyles = (parsed: ParsedArgs, io: CliIo) => {
  const color = loginUsesColor(parsed, io);
  const wrap = (open: string, close: string) => (text: string): string => color ? `${open}${text}${close}` : text;
  return {
    bold: wrap("\u001b[1m", "\u001b[22m"),
    dim: wrap("\u001b[2m", "\u001b[22m"),
    cyan: wrap("\u001b[36m", "\u001b[39m"),
    green: wrap("\u001b[32m", "\u001b[39m"),
    red: wrap("\u001b[31m", "\u001b[39m"),
    yellow: wrap("\u001b[33m", "\u001b[39m")
  };
};

const writeLoginError = (parsed: ParsedArgs, io: CliIo, code: string): void => {
  if (!loginUsesHumanOutput(parsed, io)) {
    writeError(io, code);
    return;
  }
  const style = loginStyles(parsed, io);
  const messages: Record<string, string> = {
    invalid_server_url: "The server URL is invalid. Use an HTTPS URL and try again.",
    device_authorization_expired: "Sign-in timed out. Run `isaiokay login` to try again.",
    device_code_expired: "That sign-in code has expired. Run `isaiokay login` to get a new one.",
    login_failed: "Couldn't sign in. Check your connection and try again."
  };
  io.stderr.write(`\n  ${style.red("✖")} ${style.bold(messages[code] ?? "Couldn't sign in. Please try again.")}\n`);
  io.stderr.write(`  ${style.dim(`Error: ${code}`)}\n\n`);
};

class HookInputError extends Error {
  constructor(readonly code: "input_too_large" | "input_timeout" | "invalid_json") {
    super(code);
  }
}

const readHookJson = async (input: CliIo["stdin"]): Promise<unknown> => {
  const read = async (): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.byteLength;
      if (length > MAX_INPUT_BYTES) throw new HookInputError("input_too_large");
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new HookInputError("invalid_json");
    }
  };

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          input.destroy?.();
          reject(new HookInputError("input_timeout"));
        }, HOOK_INPUT_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const help = (): Record<string, unknown> => ({
  usage: [
    `isaiokay hook --provider <${PROVIDERS.join("|")}>`,
    "isaiokay run <provider> [--command <executable>] [-- <arguments...>]",
    "isaiokay shell [install|uninstall|status|init] [bash|zsh|fish|powershell] [--profile <path>]",
    "isaiokay install|uninstall <provider|--all>",
    "isaiokay doctor [provider]",
    "isaiokay config [init|show|path]",
    "isaiokay setup [--headless|--no-open]",
    "isaiokay login [--server https://isaiokay.com] [--headless|--no-open] [--no-setup] [--json] [--no-color]",
    "isaiokay authorize <one-time-code>",
    "isaiokay logout [--local]",
    "isaiokay allowance",
    "isaiokay status",
    "isaiokay pending [list|clear]",
    "isaiokay prompt",
    "isaiokay rate [submit|show|defer <seconds>|clear]"
  ],
  privacy: "The CLI never persists prompts, responses, transcripts, cwd, repository names, or raw session IDs."
});

const COMMAND_FLAGS: Record<string, readonly string[]> = {
  hook: ["provider", "quiet"],
  run: ["command"],
  shell: ["profile"],
  install: ["all"],
  uninstall: ["all", "purge"],
  doctor: [],
  config: [],
  setup: ["server", "headless", "no-open"],
  login: ["server", "headless", "no-open", "no-setup"],
  authorize: ["code"],
  logout: ["local"],
  allowance: [],
  status: [],
  pending: [],
  prompt: [],
  rate: ["result-quality", "usage-efficiency", "item", "tags", "comment", "event-id", "no-open"]
};

const GLOBAL_FLAGS = ["help", "json", "no-color", "no-input", "verbose", "config-dir", "state-dir"] as const;

const SETUP_PROVIDERS: ReadonlyArray<{ provider: Provider; command: string; label: string }> = [
  { provider: "codex", command: "codex", label: "Codex" },
  { provider: "claude", command: "claude", label: "Claude Code" },
  { provider: "cursor", command: "agent", label: "Cursor" },
  { provider: "opencode", command: "opencode", label: "OpenCode" },
  { provider: "gemini", command: "gemini", label: "Gemini CLI" },
  { provider: "copilot", command: "copilot", label: "GitHub Copilot CLI" },
  { provider: "amp", command: "amp", label: "Amp" },
  { provider: "grok", command: "grok", label: "Grok Build" }
];

const detectSetupProviders = async (
  io: CliIo,
  configured: Partial<Record<Provider, unknown>>
): Promise<Array<{ provider: Provider; command: string; label: string }>> => {
  if (!io.commandExists) return [];
  const candidates = SETUP_PROVIDERS.filter(({ provider }) => configured[provider] === undefined);
  const results = await Promise.all(candidates.map(async (candidate) => {
    try {
      return await io.commandExists?.(candidate.command) ? candidate : null;
    } catch {
      return null;
    }
  }));
  return results.filter((candidate): candidate is { provider: Provider; command: string; label: string } => candidate !== null);
};

const COMMAND_HELP: Record<string, { summary: string; usage: string[]; notes?: string[] }> = {
  setup: { summary: "Sign in and connect detected coding tools.", usage: ["isaiokay", "isaiokay setup", "isaiokay setup --headless"], notes: ["A fresh interactive installation starts this flow when you run `isaiokay` with no arguments."] },
  login: { summary: "Sign in with a short-lived browser code.", usage: ["isaiokay login", "isaiokay login --headless", "isaiokay login --no-setup", "isaiokay login --json"] },
  rate: { summary: "Rate the most recent eligible AI coding session.", usage: ["isaiokay rate", "isaiokay rate submit --result-quality 4 --usage-efficiency 3 --item <slug>", "isaiokay rate show", "isaiokay rate defer <seconds>"], notes: ["Interactive ratings use one keyboard-driven screen and require no typing. Esc skips today without submitting."] },
  status: { summary: "Show authentication, integrations, and pending sessions.", usage: ["isaiokay status", "isaiokay status --json"] },
  doctor: { summary: "Check installed provider integrations.", usage: ["isaiokay doctor", "isaiokay doctor codex"] },
  install: { summary: "Install one provider or every detected automatic integration.", usage: ["isaiokay install --all", "isaiokay install codex"] },
  uninstall: {
    summary: "Remove only integration entries owned by IsAIokay.com.",
    usage: ["isaiokay uninstall codex", "isaiokay uninstall --all", "isaiokay uninstall --all --purge"],
    notes: ["--purge also deletes this CLI's local credential, settings, and pending-session state.", "After --all, remove the global package with `npm uninstall --global @isaiokay/cli`."]
  },
  authorize: { summary: "Approve a one-time code for another CLI.", usage: ["isaiokay authorize ABCD-EFGH"] },
  logout: { summary: "Revoke the CLI credential and sign out.", usage: ["isaiokay logout", "isaiokay logout --local"] },
  allowance: { summary: "Show how many ratings are currently available.", usage: ["isaiokay allowance"] },
  config: { summary: "Inspect local CLI configuration.", usage: ["isaiokay config show", "isaiokay config path"] },
  pending: { summary: "Inspect or clear locally pending sessions.", usage: ["isaiokay pending", "isaiokay pending clear"] },
  prompt: { summary: "Manage rating reminders.", usage: ["isaiokay prompt", "isaiokay prompt status", "isaiokay prompt never"] },
  run: {
    summary: "Run any supported AI coding harness and ask for eligible feedback after it exits.",
    usage: [
      "isaiokay run codex",
      "isaiokay run claude -- --model sonnet",
      "isaiokay run cursor --command agent -- --resume",
      "isaiokay run <provider> --command <executable> -- <arguments...>"
    ],
    notes: ["The harness keeps full terminal control. Arguments are forwarded but never stored."]
  },
  shell: {
    summary: "Keep using normal harness commands while opening eligible questionnaires automatically.",
    usage: [
      "isaiokay shell install",
      "isaiokay shell status",
      "isaiokay shell uninstall",
      "isaiokay shell init zsh",
      "isaiokay shell install powershell --profile <CurrentUserAllHosts>"
    ],
    notes: ["Install writes one clearly marked, removable block to the detected shell startup file. PowerShell users can pass $PROFILE.CurrentUserAllHosts exactly."]
  },
  hook: { summary: "Accept a machine-readable provider lifecycle event.", usage: ["isaiokay hook --provider codex < event.json"], notes: ["Hook output is always JSON and never prompts."] }
};

const writeHelp = (parsed: ParsedArgs, io: CliIo, command?: string): void => {
  if (!loginUsesHumanOutput(parsed, io)) {
    writeJson(io, command && COMMAND_HELP[command] ? { command, ...COMMAND_HELP[command] } : help());
    return;
  }
  const style = loginStyles(parsed, io);
  const detail = command ? COMMAND_HELP[command] : undefined;
  io.stdout.write(`\n  ${style.bold(style.cyan("IsAIokay.com CLI"))} ${style.dim(`v${CLI_VERSION}`)}\n`);
  if (detail) {
    io.stdout.write(`  ${detail.summary}\n\n  ${style.bold("Usage")}\n`);
    for (const usage of detail.usage) io.stdout.write(`    ${style.cyan(usage)}\n`);
    for (const note of detail.notes ?? []) io.stdout.write(`\n  ${style.dim(note)}\n`);
  } else {
    io.stdout.write("  Privacy-preserving feedback for AI coding sessions.\n\n");
    io.stdout.write(`  ${style.bold("Common commands")}\n`);
    io.stdout.write("    setup              Sign in and connect coding tools\n");
    io.stdout.write("    login              Sign in\n");
    io.stdout.write("    install --all       Connect detected coding CLIs\n");
    io.stdout.write("    run <provider>      Run a harness and ask afterward\n");
    io.stdout.write("    shell install       Keep using normal harness commands\n");
    io.stdout.write("    status             Show CLI status\n");
    io.stdout.write("    rate               Rate a recent session\n");
    io.stdout.write("    doctor             Check integrations\n\n");
    io.stdout.write(`  Run ${style.cyan("isaiokay help <command>")} for details.\n`);
  }
  io.stdout.write(`\n  ${style.dim("The CLI never stores prompts, responses, transcripts, repository names, paths, or raw session IDs.")}\n\n`);
};

const writeArgumentError = (parsed: ParsedArgs, io: CliIo, message: string, code: string): void => {
  if (!loginUsesHumanOutput(parsed, io)) {
    writeError(io, code);
    return;
  }
  const style = loginStyles(parsed, io);
  io.stderr.write(`\n  ${style.red("✖")} ${style.bold(message)}\n`);
  if (parsed.command && COMMAND_HELP[parsed.command]) io.stderr.write(`  Run ${style.cyan(`isaiokay help ${parsed.command}`)} for usage.\n`);
  io.stderr.write("\n");
};

const ERROR_MESSAGES: Record<string, string> = {
  authentication_required_run_isaiokay_login: "You're not signed in. Run `isaiokay login` first.",
  device_code_required: "A one-time code is required. Example: `isaiokay authorize ABCD-EFGH`.",
  invalid_provider: `Choose a supported provider: ${PROVIDERS.join(", ")}.`,
  ratings_must_be_integers_1_to_5: "Both ratings must be between 1 and 5.",
  no_pending_session: "There isn't a recent session waiting to be rated.",
  rating_answers_required_use_flags: "Rating needs an interactive terminal, or --result-quality and --usage-efficiency.",
  item_confirmation_required_use_item_slug: "The model must be confirmed. Use an interactive terminal or pass `--item <slug>`.",
  model_catalog_empty: "No models are currently available to select.",
  invalid_defer_seconds: "Choose a reminder delay from 1 to 86400 seconds.",
  invalid_rate_operation: "Unknown rating action.",
  invalid_prompt_operation: "Unknown prompt action.",
  invalid_pending_operation: "Unknown pending-session action.",
  invalid_config_operation: "Unknown configuration action.",
  harness_command_required: "This harness has no default terminal command. Pass `--command <executable>`.",
  harness_launch_failed: "The coding harness could not be started. Check the executable or pass `--command <executable>`.",
  interactive_terminal_required: "`isaiokay run` requires an interactive terminal so it can open the questionnaire afterward.",
  unsupported_shell: "Choose a supported shell: bash, zsh, fish, or powershell.",
  invalid_shell_operation: "Choose a shell action: install, uninstall, status, or init.",
  purge_requires_all: "Use --purge together with `isaiokay uninstall --all`.",
  shell_integration_failed: "The shell integration could not be updated safely.",
  local_state_unavailable: "The local CLI state could not be read or updated."
};

const writeCommandError = (parsed: ParsedArgs, io: CliIo, code: string, fallback?: string): void => {
  if (!loginUsesHumanOutput(parsed, io)) {
    writeError(io, code);
    return;
  }
  const style = loginStyles(parsed, io);
  io.stderr.write(`\n  ${style.red("✖")} ${style.bold(ERROR_MESSAGES[code] ?? fallback ?? "The command could not be completed.")}\n`);
  if (parsed.flags.has("verbose")) io.stderr.write(`  ${style.dim(`Error: ${code}`)}\n`);
  io.stderr.write("\n");
};

const persistentInstallCommands = [
  "npm install --global @isaiokay/cli",
  "pnpm add --global @isaiokay/cli",
  "bun add --global @isaiokay/cli"
] as const;

const writePersistentInstallRequired = (parsed: ParsedArgs, io: CliIo, runner: OneShotRunner): void => {
  if (!loginUsesHumanOutput(parsed, io)) {
    writeJson(io, {
      installed: false,
      error: {
        code: "persistent_install_required",
        message: `Automatic integrations cannot be installed from ${runner}.`,
        runner,
        installCommands: persistentInstallCommands
      }
    });
    return;
  }
  const style = loginStyles(parsed, io);
  io.stderr.write(`\n  ${style.yellow("!")} ${style.bold("Install the CLI persistently before connecting integrations.")}\n`);
  io.stderr.write(`  ${style.dim(`${runner} exposes isaiokay only for this one command; lifecycle hooks need it later.`)}\n\n`);
  for (const command of persistentInstallCommands) io.stderr.write(`    ${style.cyan(command)}\n`);
  io.stderr.write(`\n  Then run ${style.cyan("isaiokay setup")}.\n\n`);
};

const writeOneShotLoginNotice = (parsed: ParsedArgs, io: CliIo, runner: OneShotRunner): void => {
  const style = loginStyles(parsed, io);
  io.stdout.write(`  ${style.yellow("!")} ${style.bold(`Signed in through ${runner}; integration setup was skipped.`)}\n`);
  io.stdout.write(`  ${style.dim("Your sign-in was saved, but lifecycle hooks require a persistent CLI.")}\n`);
  io.stdout.write("  Install with one of:\n");
  for (const command of persistentInstallCommands) io.stdout.write(`    ${style.cyan(command)}\n`);
  io.stdout.write(`  Then run ${style.cyan("isaiokay setup")}.\n\n`);
};

const writeResult = (parsed: ParsedArgs, io: CliIo, body: unknown, render: (style: ReturnType<typeof loginStyles>) => void): void => {
  if (loginUsesHumanOutput(parsed, io)) render(loginStyles(parsed, io));
  else writeJson(io, body);
};

const foregroundSessionHash = (
  io: CliIo,
  provider: Provider,
  hmacSecret: string
): string | null => {
  const wrapperProvider = parseProvider(io.env?.[FOREGROUND_PROVIDER_ENV]);
  const wrapperSession = io.env?.[FOREGROUND_SESSION_ENV];
  if (wrapperProvider !== provider || !wrapperSession || !isUuid(wrapperSession)) return null;
  return hashSession(hmacSecret, wrapperSession);
};

const wrapperEvent = (
  provider: Provider,
  sessionHash: string,
  occurredAt: number,
  id: string
): StoredEvent => ({
  schemaVersion: 1,
  id,
  provider,
  attribution: "manual",
  model: null,
  sessionHash,
  occurredAt,
  recordedAt: occurredAt
});

const writeRunWarning = (parsed: ParsedArgs, io: CliIo, message: string): void => {
  const style = loginStyles(parsed, io);
  io.stderr.write(`\n  ${style.yellow("!")} ${message}\n\n`);
};

const providerLabel = (provider: Provider): string => ({
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot CLI",
  cline: "Cline",
  windsurf: "Windsurf",
  aider: "Aider",
  amp: "Amp",
  grok: "Grok Build",
  muse: "Muse Code"
})[provider];

const nextLocalDay = (now: number): number => {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return tomorrow.getTime();
};

const runHook = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const result = (body: Record<string, unknown>, systemMessage?: string): void => {
    writeJson(io, systemMessage ? { systemMessage } : parsed.flags.has("quiet") ? {} : body);
  };
  const provider = parseProvider(flagText(parsed.flags, "provider"));
  if (provider === null) {
    result({ accepted: false, reason: "invalid_provider" });
    return 0;
  }
  let payload: unknown;
  try {
    payload = await readHookJson(io.stdin);
  } catch (error) {
    const reason = error instanceof HookInputError ? error.code : "invalid_json";
    result(safeEventSummary(provider, false, reason));
    return 0;
  }
  try {
    const config = await store.getConfig();
    const normalized = normalizeProviderEvent(provider, payload, config.hmacSecret, io.now?.() ?? Date.now());
    if (!normalized.accepted) {
      result(safeEventSummary(provider, false, normalized.reason));
      return 0;
    }
    const wrapperHash = foregroundSessionHash(io, provider, config.hmacSecret);
    const event = wrapperHash === null ? normalized.event : { ...normalized.event, sessionHash: wrapperHash };
    await store.recordEvent(event);
    if (!normalized.notificationSafe) {
      result({
        accepted: true,
        provider: event.provider,
        attribution: event.attribution,
        model: event.model,
        occurredAt: event.occurredAt,
        notificationSafe: false,
        promptDeferredToForeground: wrapperHash !== null
      });
      return 0;
    }
    const prompt = await store.claimPrompt(io.now?.() ?? Date.now(), "hook");
    result({
      accepted: true,
      provider: event.provider,
      attribution: event.attribution,
      model: event.model,
      occurredAt: event.occurredAt,
      prompt
    }, prompt.eligible
      ? `You've had some real time with ${providerLabel(provider)} today. Want to capture how it felt? Run \`isaiokay rate\` for a 30-second check-in. I won't ask again today.`
      : undefined);
  } catch {
    // A hook must never disrupt its host application for a local telemetry fault.
    result(safeEventSummary(provider, false, "local_state_unavailable"));
  }
  return 0;
};

const runHarness = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const provider = parseProvider(parsed.positionals[0]);
  if (provider === null) {
    writeCommandError(parsed, io, "invalid_provider");
    return 1;
  }
  if (parsed.positionals.length !== 1) {
    writeArgumentError(parsed, io, "Put harness arguments after `--` so they are forwarded unchanged.", "invalid_run_arguments");
    return 1;
  }
  if (parsed.flags.has("command") && flagText(parsed.flags, "command") === undefined) {
    writeArgumentError(parsed, io, "`--command` requires an executable name or path.", "harness_command_required");
    return 1;
  }
  const command = flagText(parsed.flags, "command") ?? defaultHarnessCommand(provider);
  if (!command) {
    writeCommandError(parsed, io, "harness_command_required");
    return 1;
  }
  if (command.length > 4_096 || /[\0\r\n]/.test(command)) {
    writeArgumentError(parsed, io, "The harness executable is malformed.", "harness_command_required");
    return 1;
  }
  if (!io.runCommand || parsed.flags.has("json") || parsed.flags.has("no-input")) {
    writeCommandError(parsed, io, "interactive_terminal_required");
    return 1;
  }
  if (io.stdout.isTTY !== true || !io.form) {
    try {
      const result = await io.runCommand(command, parsed.passthrough, io.env ?? process.env);
      return result.exitCode;
    } catch {
      writeCommandError(parsed, io, "harness_launch_failed");
      return 127;
    }
  }

  const createId = (): string => io.createId?.() ?? createEventId();
  const rawWrapperSession = createId();
  let sessionHash: string | null = null;
  const startedAt = io.now?.() ?? Date.now();
  try {
    const config = await store.getConfig();
    sessionHash = hashSession(config.hmacSecret, rawWrapperSession);
  } catch {
    writeRunWarning(parsed, io, "Session tracking is unavailable; the harness will still run.");
    sessionHash = null;
  }

  let harnessResult: { exitCode: number; signal: NodeJS.Signals | null };
  try {
    harnessResult = await io.runCommand(command, parsed.passthrough, {
      ...(io.env ?? process.env),
      ...(sessionHash === null ? {} : {
        [FOREGROUND_SESSION_ENV]: rawWrapperSession,
        [FOREGROUND_PROVIDER_ENV]: provider
      })
    });
  } catch {
    writeCommandError(parsed, io, "harness_launch_failed");
    return 127;
  }

  if (sessionHash !== null) {
    try {
      const endedAt = io.now?.() ?? Date.now();
      await store.recordEvents([
        wrapperEvent(provider, sessionHash, startedAt, createId()),
        wrapperEvent(provider, sessionHash, endedAt, createId())
      ]);
      if (harnessResult.signal === null && harnessResult.exitCode !== 130) {
        const promptFlags = new Map(
          [...parsed.flags].filter(([flag]) => (GLOBAL_FLAGS as readonly string[]).includes(flag))
        );
        await runPrompt(
          { command: "prompt", positionals: [], passthrough: [], flags: promptFlags },
          store,
          io,
          { silentWhenIneligible: true }
        );
      }
    } catch (error) {
      if (error instanceof CliCancelledError) {
        const style = loginStyles(parsed, io);
        io.stdout.write(`\n  ${style.yellow("!")} Rating cancelled. Nothing was submitted.\n\n`);
      } else {
        writeRunWarning(parsed, io, "The feedback prompt could not be opened; the harness result is unchanged.");
      }
    }
  }

  return harnessResult.exitCode;
};

const parseSupportedShell = (value: string | undefined): SupportedShell | null =>
  value === "bash" || value === "zsh" || value === "fish" || value === "powershell" || value === "pwsh"
    ? value === "pwsh" ? "powershell" : value
    : null;

const runShellIntegration = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const operation = parsed.positionals[0] ?? "status";
  if (!["install", "uninstall", "status", "init"].includes(operation)) {
    writeCommandError(parsed, io, "invalid_shell_operation");
    return 1;
  }
  if (parsed.positionals.length > 2) {
    writeArgumentError(parsed, io, "Too many shell arguments.", "invalid_shell_operation");
    return 1;
  }
  const explicitShell = parsed.positionals[1];
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const shell = parseSupportedShell(explicitShell) ?? detectShell(env, platform);
  if (!shell || (explicitShell !== undefined && parseSupportedShell(explicitShell) === null)) {
    writeCommandError(parsed, io, "unsupported_shell");
    return 1;
  }
  const profilePath = flagText(parsed.flags, "profile");
  if ((parsed.flags.has("profile") && profilePath === undefined) || (profilePath !== undefined && shell !== "powershell")) {
    writeArgumentError(parsed, io, "--profile requires a PowerShell profile path.", "invalid_shell_profile");
    return 1;
  }
  if (operation === "init") {
    io.stdout.write(renderShellIntegration(shell));
    return 0;
  }

  const home = io.home ?? homedir();
  const options = { env, platform, ...(profilePath === undefined ? {} : { profilePath }) };
  try {
    if (operation === "status") {
      const installed = await shellIntegrationInstalled(shell, home, options);
      const path = shellIntegrationPath(shell, home, options);
      writeResult(parsed, io, { shell, path, installed }, (style) => {
        io.stdout.write(`\n  ${style.bold(style.cyan("Automatic questionnaire"))}\n`);
        io.stdout.write(`  ${installed ? style.green("✓ Installed") : style.dim("Not installed")}  ${path}\n\n`);
      });
      return 0;
    }

    const result = operation === "install"
      ? await installShellIntegration(shell, home, options)
      : await uninstallShellIntegration(shell, home, options);
    const installed = operation === "install";
    if (installed) await store.registerShellIntegration(shell, result.path);
    else await store.unregisterShellIntegration(result.path);
    writeResult(parsed, io, { shell, path: result.path, installed, changed: result.changed }, (style) => {
      const action = installed ? "Automatic questionnaires enabled." : "Automatic questionnaires disabled.";
      io.stdout.write(`\n  ${style.green("✓")} ${style.bold(action)}\n`);
      io.stdout.write(`  ${style.dim(result.path)}\n`);
      if (result.changed) io.stdout.write(`  ${style.dim("Open a new terminal for the change to take effect.")}\n`);
      if (installed) io.stdout.write(`  Keep using ${style.cyan("codex")}, ${style.cyan("claude")}, ${style.cyan("agent")}, and your other normal commands.\n`);
      io.stdout.write("\n");
    });
    return 0;
  } catch {
    writeCommandError(parsed, io, "shell_integration_failed");
    return 1;
  }
};

const runConfig = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const operation = parsed.positionals[0] ?? "show";
  if (operation === "path") {
    const body = { configFile: store.paths.configFile, stateFile: store.paths.stateFile };
    writeResult(parsed, io, body, (style) => {
      io.stdout.write(`\n  ${style.bold(style.cyan("Local files"))}\n`);
      io.stdout.write(`  Config  ${body.configFile}\n  State   ${body.stateFile}\n\n`);
    });
    return 0;
  }
  if (operation !== "show" && operation !== "init") {
    writeCommandError(parsed, io, "invalid_config_operation");
    return 1;
  }
  const config = await store.getConfig();
  const body = {
    initialized: true,
    schemaVersion: config.schemaVersion,
    hmacConfigured: true,
    onboardingCompleted: config.onboardingCompletedAt !== null,
    adapters: Object.keys(config.adapters).sort()
  };
  writeResult(parsed, io, body, (style) => {
    io.stdout.write(`\n  ${style.bold(style.cyan("Configuration"))}\n`);
    io.stdout.write(`  ${style.green("✓")} Initialized\n`);
    io.stdout.write(`  Integrations  ${body.adapters.length > 0 ? body.adapters.join(", ") : "None"}\n\n`);
  });
  return 0;
};

const runStatus = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const [config, state, credential] = await Promise.all([store.getConfig(), store.getState(), store.getCredential()]);
  const detected = loginUsesHumanOutput(parsed, io) ? await detectSetupProviders(io, config.adapters) : [];
  const authenticated = credential !== null && credential.expiresAt > (io.now?.() ?? Date.now());
  const body = {
    schemaVersion: 1,
    authenticated,
    serverUrl: credential?.serverUrl ?? null,
    adapters: Object.keys(config.adapters).sort(),
    eventCount: state.events.length,
    pendingCount: state.pendingEventIds.length,
    nextAllowedAt: state.rate.nextAllowedAt,
    prompt: decidePrompt(state, io.now?.() ?? Date.now()),
    promptsDisabled: state.rate.promptsDisabled
  };
  writeResult(parsed, io, body, (style) => {
    io.stdout.write(`\n  ${style.bold(style.cyan("IsAIokay.com"))}\n\n`);
    io.stdout.write(`  ${authenticated ? style.green("✓") : style.yellow("!")} ${authenticated ? "Signed in" : "Not signed in"}\n`);
    if (body.serverUrl) io.stdout.write(`  Server        ${body.serverUrl}\n`);
    io.stdout.write(`  Integrations  ${body.adapters.length > 0 ? body.adapters.join(", ") : "None installed"}\n`);
    if (detected.length > 0) io.stdout.write(`  Detected      ${detected.map(({ label }) => label).join(", ")}\n`);
    io.stdout.write(`  Sessions      ${body.eventCount} recorded · ${body.pendingCount} pending\n`);
    io.stdout.write(`  Reminders     ${body.promptsDisabled ? "Off" : "On"}\n`);
    if (!authenticated || detected.length > 0) io.stdout.write(`\n  ${style.bold("Suggested next steps")}\n`);
    if (!authenticated) io.stdout.write(`    ${style.cyan("isaiokay login")}\n`);
    if (detected.length > 1) io.stdout.write(`    ${style.cyan("isaiokay install --all")}  ${style.dim("Install every detected integration")}\n`);
    for (const { provider, label } of detected) {
      io.stdout.write(`    ${style.cyan(`isaiokay install ${provider}`)}  ${style.dim(`Install the ${label} integration`)}\n`);
    }
    io.stdout.write("\n");
  });
  return 0;
};

const runPending = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const operation = parsed.positionals[0] ?? "list";
  if (operation === "clear") {
    const state = await store.clearPending();
    const body = { cleared: true, pendingCount: state.pendingEventIds.length };
    writeResult(parsed, io, body, (style) => io.stdout.write(`\n  ${style.green("✓")} Pending sessions cleared.\n\n`));
    return 0;
  }
  if (operation !== "list") {
    writeCommandError(parsed, io, "invalid_pending_operation");
    return 1;
  }
  const state = await store.getState();
  const body = { pendingCount: state.pendingEventIds.length };
  writeResult(parsed, io, body, (style) => {
    io.stdout.write(`\n  ${style.bold("Pending sessions")}  ${body.pendingCount}\n`);
    if (body.pendingCount > 0) io.stdout.write(`  Run ${style.cyan("isaiokay rate")} to rate the latest one.\n`);
    io.stdout.write("\n");
  });
  return 0;
};

const fetcherFor = (io: CliIo): typeof fetch => io.fetch ?? globalThis.fetch;

const sleepFor = (io: CliIo, milliseconds: number): Promise<void> => io.sleep?.(milliseconds) ?? new Promise((resolve) => setTimeout(resolve, milliseconds));

const cliVerificationDetails = (error: ApiError, serverUrl: string, now: number): { challengeId: string; verificationUrl: string; expiresAt: number } | null => {
  if (error.code !== "cli_verification_required" || !error.details) return null;
  const challengeId = error.details.challengeId;
  const verificationUrl = error.details.verificationUrl;
  const expiresAt = error.details.expiresAt;
  const normalizedVerificationUrl = normalizeSameOriginWebUrl(verificationUrl, serverUrl);
  if (!isUuid(challengeId) || normalizedVerificationUrl === null || typeof expiresAt !== "string") return null;
  const parsedExpiry = Date.parse(expiresAt);
  return Number.isFinite(parsedExpiry) && parsedExpiry > now && parsedExpiry <= now + 15 * 60_000
    ? { challengeId, verificationUrl: normalizedVerificationUrl, expiresAt: parsedExpiry }
    : null;
};

const waitForCliBrowserProof = async (
  parsed: ParsedArgs,
  credential: CliCredential,
  io: CliIo,
  challenge: { challengeId: string; verificationUrl: string; expiresAt: number }
): Promise<{ challengeId: string; challengeProof: string }> => {
  const body = { submitted: false, verificationRequired: true, verificationUrl: challenge.verificationUrl, expiresAt: new Date(challenge.expiresAt).toISOString() };
  writeResult(parsed, io, body, (style) => {
    io.stdout.write(`\n  ${style.yellow("!")} Browser verification is required.\n`);
    io.stdout.write(`  ${style.cyan(challenge.verificationUrl)}\n`);
    io.stdout.write(`  ${style.dim("Waiting for verification…  Press Ctrl+C to cancel.")}\n`);
  });
  if (!parsed.flags.has("no-open")) await io.openUrl?.(challenge.verificationUrl);
  while ((io.now?.() ?? Date.now()) < challenge.expiresAt) {
    await sleepFor(io, 2_000);
    const status = await getCliTurnstileChallenge(fetcherFor(io), credential, challenge.challengeId);
    if (status.status === "verified" && status.challengeProof) {
      return { challengeId: challenge.challengeId, challengeProof: status.challengeProof };
    }
    if (status.status === "expired") throw new ApiError(410, "cli_verification_expired", "The browser verification link expired.");
    if (status.status === "consumed") throw new ApiError(409, "cli_verification_replayed", "The browser verification proof was already used.");
  }
  throw new ApiError(410, "cli_verification_expired", "The browser verification link expired.");
};

const requireCredential = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<CliCredential | null> => {
  const credential = await store.getCredential();
  if (!credential || credential.expiresAt <= (io.now?.() ?? Date.now())) {
    writeCommandError(parsed, io, "authentication_required_run_isaiokay_login");
    return null;
  }
  return credential;
};

const normalizeServerUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const offerDetectedIntegrations = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<void> => {
  if (!loginUsesHumanOutput(parsed, io) || !io.selectMany || !io.commandExists || parsed.flags.has("no-input") || parsed.flags.has("no-setup")) return;
  const config = await store.getConfig();
  const detected = await detectSetupProviders(io, config.adapters);
  if (detected.length === 0) return;

  const style = loginStyles(parsed, io);
  io.stdout.write(`  ${style.bold(style.cyan("Detected coding CLIs"))}\n`);
  io.stdout.write(`  ${style.dim("Choose where to install the privacy-safe session hook.")}\n\n`);
  const selected = await io.selectMany(
    "Install integrations (optional)",
    detected.map(({ provider, command, label }) => ({ value: provider, label, hint: `${command} found in PATH` })),
    {
      color: loginUsesColor(parsed, io),
      initialValues: detected.map(({ provider }) => provider),
      maxSelections: detected.length
    }
  );
  if (selected === undefined) throw new CliCancelledError();
  if (selected.length === 0) {
    io.stdout.write(`\n  ${style.dim("No integrations installed. You can run `isaiokay install <provider>` later.")}\n\n`);
    return;
  }

  io.stdout.write(`\n  ${style.dim("Installing selected integrations…")}\n`);
  for (const value of selected) {
    const provider = parseProvider(value);
    if (!provider || !detected.some((candidate) => candidate.provider === provider)) continue;
    try {
      const { integration } = await installAdapter(store, provider, { now: io.now?.() ?? Date.now(), home: io.home ?? homedir() });
      io.stdout.write(`  ${style.green("✓")} ${integration.message}\n`);
    } catch (error) {
      io.stdout.write(`  ${style.red("✖")} ${provider}: ${error instanceof Error ? error.message : "installation failed"}\n`);
    }
  }
  io.stdout.write(`\n  Run ${style.cyan("isaiokay doctor")} to check integration health.\n\n`);
};

const offerShellIntegration = async (parsed: ParsedArgs, io: CliIo): Promise<void> => {
  if (!loginUsesHumanOutput(parsed, io) || !io.select || parsed.flags.has("no-input") || parsed.flags.has("no-setup")) return;
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const shell = detectShell(env, platform);
  const options = { env, platform };
  if (!shell || await shellIntegrationInstalled(shell, io.home ?? homedir(), options)) return;
  const style = loginStyles(parsed, io);
  const response = await io.select("Open eligible questionnaires automatically?", [
    { value: "enable", label: "Enable", hint: `keep using normal ${shell} commands` },
    { value: "later", label: "Not now" }
  ], { initialValue: "enable", color: loginUsesColor(parsed, io) });
  if (response === undefined) throw new CliCancelledError();
  if (response !== "enable") {
    io.stdout.write(`\n  ${style.dim("You can enable this later with `isaiokay shell install`.")}\n\n`);
    return;
  }
  const result = await installShellIntegration(shell, io.home ?? homedir(), options);
  io.stdout.write(`\n  ${style.green("✓")} ${style.bold("Automatic questionnaires enabled.")}\n`);
  io.stdout.write(`  ${style.dim(result.path)}\n`);
  io.stdout.write(`  ${style.dim("Open a new terminal, then keep using your normal harness commands.")}\n\n`);
};

const canRunInteractiveSetup = (parsed: ParsedArgs, io: CliIo): boolean =>
  loginUsesHumanOutput(parsed, io)
  && !parsed.flags.has("no-input")
  && !parsed.flags.has("no-setup")
  && io.select !== undefined
  && io.selectMany !== undefined
  && io.commandExists !== undefined;

const finishInteractiveSetup = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<boolean> => {
  if (!canRunInteractiveSetup(parsed, io)) return false;
  const style = loginStyles(parsed, io);
  try {
    await offerDetectedIntegrations(parsed, store, io);
    await offerShellIntegration(parsed, io);
    await store.completeOnboarding(io.now?.() ?? Date.now());
    io.stdout.write(`  ${style.green("✓")} ${style.bold("Setup complete.")}\n`);
    io.stdout.write(`  ${style.dim("Keep using your normal coding CLI commands; eligible questionnaires open after a session.")}\n\n`);
    return true;
  } catch (error) {
    const message = error instanceof CliCancelledError
      ? "Setup paused. Run"
      : "Optional integration setup was skipped. Run";
    io.stdout.write(`  ${style.yellow("!")} ${message} ${style.cyan("isaiokay setup")} later.\n\n`);
    return false;
  }
};

const runLogin = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const serverUrl = normalizeServerUrl(flagText(parsed.flags, "server") ?? io.env?.ISAI_OKAY_URL ?? "https://isaiokay.com");
  if (!serverUrl) {
    writeLoginError(parsed, io, "invalid_server_url");
    return 1;
  }
  const humanOutput = loginUsesHumanOutput(parsed, io);
  const style = loginStyles(parsed, io);
  if (humanOutput) {
    io.stdout.write(`\n  ${style.bold(style.cyan("IsAIokay.com"))}\n`);
    const introduction = parsed.flags.has("no-setup")
      ? "Signing you in…"
      : "Let’s connect your account and coding tools. This takes about a minute.";
    io.stdout.write(`  ${style.dim(introduction)}\n`);
  }
  try {
    const started = await startDeviceLogin(fetcherFor(io), serverUrl);
    const forcedHeadless = parsed.flags.has("headless") || parsed.flags.has("no-open");
    let mode: "browser" | "headless" = "headless";
    let browserLaunchFailed = false;
    if (!forcedHeadless && io.browserAvailable !== false && io.openUrl) {
      try {
        await io.openUrl(started.verificationUriComplete);
        mode = "browser";
      } catch {
        browserLaunchFailed = true;
        // A desktop session can still lack a usable browser launcher. Keep the
        // device flow alive and present the terminal approval path instead.
      }
    }
    if (humanOutput) {
      const code = style.bold(style.yellow(started.userCode));
      const url = style.cyan(started.verificationUriComplete);
      if (mode === "browser") {
        io.stdout.write(`\n  ${style.green("✓")} Browser opened\n`);
        io.stdout.write("  Finish signing in there, then return to this terminal.\n\n");
        io.stdout.write(`  One-time code  ${code}\n`);
        io.stdout.write(`  ${style.dim("Browser didn't open? Visit:")} ${url}\n`);
      } else {
        if (browserLaunchFailed) io.stdout.write(`\n  ${style.yellow("!")} Your browser could not be opened automatically.\n`);
        else io.stdout.write(`\n  ${style.yellow("!")} No browser will be opened on this machine.\n`);
        io.stdout.write("\n  Open this link on a device with a browser:\n");
        io.stdout.write(`  ${url}\n\n`);
        io.stdout.write(`  Confirm the code  ${code}\n\n`);
        io.stdout.write(`  ${style.dim("Already signed in with the CLI on another computer?")}\n`);
        io.stdout.write(`  Run ${style.cyan(`isaiokay authorize ${started.userCode}`)} there instead.\n`);
      }
      io.stdout.write(`\n  ${style.dim("Waiting for approval…  Press Ctrl+C to cancel.")}\n`);
    } else {
      writeJson(io, {
        action: "authorize",
        mode,
        userCode: started.userCode,
        url: started.verificationUriComplete,
        headlessCommand: `isaiokay authorize ${started.userCode}`
      });
    }
    const deadline = (io.now?.() ?? Date.now()) + started.expiresIn * 1_000;
    while ((io.now?.() ?? Date.now()) < deadline) {
      try {
        const token = await pollDeviceLogin(fetcherFor(io), serverUrl, started.deviceCode);
        await store.saveCredential({
          schemaVersion: 1,
          serverUrl,
          accessToken: token.accessToken,
          expiresAt: (io.now?.() ?? Date.now()) + token.expiresIn * 1_000
        });
        const oneShotRunner = detectOneShotRunner(io.env);
        if (humanOutput) {
          io.stdout.write(`\n  ${style.green("✓")} ${style.bold("You're signed in.")}\n`);
          io.stdout.write(`  ${style.dim(`Connected to ${serverUrl}`)}\n\n`);
          if (oneShotRunner) {
            writeOneShotLoginNotice(parsed, io, oneShotRunner);
            if (parsed.command === "setup") return 1;
          } else {
            const setupCompleted = await finishInteractiveSetup(parsed, store, io);
            if (parsed.command === "setup" && !setupCompleted) return 1;
          }
        } else {
          writeJson(io, {
            authenticated: true,
            serverUrl,
            ...(oneShotRunner ? {
              setupSkipped: "persistent_install_required",
              runner: oneShotRunner,
              installCommands: persistentInstallCommands
            } : {})
          });
        }
        return 0;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "authorization_pending") throw error;
      }
      await sleepFor(io, Math.max(1, started.interval) * 1_000);
    }
    writeLoginError(parsed, io, "device_authorization_expired");
    return 1;
  } catch (error) {
    writeLoginError(parsed, io, error instanceof ApiError ? error.code : "login_failed");
    return 1;
  }
};

const runSetup = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  if (!canRunInteractiveSetup(parsed, io)) {
    writeArgumentError(parsed, io, "Setup requires an interactive terminal. Run it again without --no-input.", "interactive_setup_required");
    return 1;
  }
  const credential = await store.getCredential();
  const authenticated = credential !== null && credential.expiresAt > (io.now?.() ?? Date.now());
  if (!authenticated) return runLogin(parsed, store, io);
  const style = loginStyles(parsed, io);
  io.stdout.write(`\n  ${style.bold(style.cyan("IsAIokay.com"))}\n`);
  io.stdout.write(`  ${style.green("✓")} Already signed in\n\n`);
  const oneShotRunner = detectOneShotRunner(io.env);
  if (oneShotRunner) {
    writePersistentInstallRequired(parsed, io, oneShotRunner);
    return 1;
  }
  return await finishInteractiveSetup(parsed, store, io) ? 0 : 1;
};

const runAuthorize = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const credential = await requireCredential(parsed, store, io);
  if (!credential) return 1;
  const userCode = parsed.positionals[0] ?? flagText(parsed.flags, "code");
  if (!userCode) {
    writeCommandError(parsed, io, "device_code_required");
    return 1;
  }
  try {
    const result = await approveDeviceLogin(fetcherFor(io), credential, userCode);
    const body = { approved: true, userCode, clientName: result.clientName };
    writeResult(parsed, io, body, (style) => io.stdout.write(`\n  ${style.green("✓")} ${style.bold(`${result.clientName} is authorized.`)}\n\n`));
    return 0;
  } catch (error) {
    writeCommandError(parsed, io, error instanceof ApiError ? error.code : "device_approval_failed", error instanceof Error ? error.message : undefined);
    return 1;
  }
};

const runLogout = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const credential = await store.getCredential();
  if (!credential) {
    writeResult(parsed, io, { authenticated: false }, (style) => io.stdout.write(`\n  ${style.dim("You're already signed out.")}\n\n`));
    return 0;
  }
  if (!parsed.flags.has("local")) {
    try {
      await revokeCredential(fetcherFor(io), credential);
    } catch (error) {
      writeCommandError(parsed, io, error instanceof ApiError ? error.code : "logout_failed", error instanceof Error ? error.message : undefined);
      return 1;
    }
  }
  await store.clearCredential();
  const body = { authenticated: false, revoked: !parsed.flags.has("local") };
  writeResult(parsed, io, body, (style) => io.stdout.write(`\n  ${style.green("✓")} ${style.bold("You're signed out.")}\n\n`));
  return 0;
};

const runAllowance = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const credential = await requireCredential(parsed, store, io);
  if (!credential) return 1;
  try {
    const body = await getAllowance(fetcherFor(io), credential);
    writeResult(parsed, io, body, (style) => {
      const remaining = typeof body.remaining === "number" ? body.remaining : 0;
      const next = typeof body.nextAvailableAt === "string" ? new Date(body.nextAvailableAt).toLocaleString() : null;
      io.stdout.write(`\n  ${style.bold(style.cyan("Rating allowance"))}\n`);
      io.stdout.write(`  ${style.bold(String(remaining))} rating${remaining === 1 ? "" : "s"} available\n`);
      if (next) io.stdout.write(`  Next available  ${next}\n`);
      io.stdout.write("\n");
    });
    return 0;
  } catch (error) {
    writeCommandError(parsed, io, error instanceof ApiError ? error.code : "allowance_failed", error instanceof Error ? error.message : undefined);
    return 1;
  }
};

const providerTool = (provider: Provider): string => ({
  codex: "codex",
  claude: "claude-code",
  cursor: "cursor",
  opencode: "opencode",
  gemini: "gemini-cli",
  copilot: "copilot-cli",
  cline: "cline",
  windsurf: "windsurf",
  aider: "aider",
  amp: "amp",
  grok: "grok-build",
  muse: "muse-code"
})[provider];

const serverAttribution = (event: StoredEvent, mixed: boolean): string => {
  if (mixed) return "mixed";
  switch (event.attribution) {
    case "session_start": return "verified_start_only";
    case "opaque_auto": return "opaque_router";
    case "session_end_unknown": return "unknown";
    case "task_complete": return "model_at_end";
    case "agent_end": return event.model === null ? "unknown" : "model_at_end";
    case "manual": return "user_confirmed";
    default: return "verified_active";
  }
};

const durationBucket = (events: StoredEvent[]): string => {
  const times = events.map((event) => event.occurredAt);
  const duration = Math.max(...times) - Math.min(...times);
  if (!Number.isFinite(duration) || duration <= 0) return "unknown";
  if (duration < 10 * 60_000) return "under_10m";
  if (duration < 30 * 60_000) return "10_30m";
  if (duration < 60 * 60_000) return "30_60m";
  return "over_60m";
};

class CliCancelledError extends Error {}

const RESULT_QUALITY_CHOICES: readonly TerminalChoice[] = [
  { value: "5", label: "5 — Excellent" },
  { value: "4", label: "4 — Good" },
  { value: "3", label: "3 — Okay" },
  { value: "2", label: "2 — Poor" },
  { value: "1", label: "1 — Unusable" }
];

const USAGE_EFFICIENCY_CHOICES: readonly TerminalChoice[] = [
  { value: "5", label: "5 — Very efficient" },
  { value: "4", label: "4 — Efficient" },
  { value: "3", label: "3 — About expected" },
  { value: "2", label: "2 — Heavy" },
  { value: "1", label: "1 — Burned too fast" }
];

const MODEL_PROVIDER_BY_HARNESS: Partial<Record<Provider, string>> = {
  claude: "anthropic",
  codex: "openai",
  gemini: "google",
  grok: "xai",
  muse: "meta"
};

const catalogKey = (value: string): string => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

const providerAwareModelCatalog = (items: ApiTrackedItem[], provider: Provider): ApiTrackedItem[] => {
  const models = items.filter((item) => item.type === "model");
  const providerName = MODEL_PROVIDER_BY_HARNESS[provider];
  if (!providerName) return models;
  const scoped = models.filter((item) => catalogKey(item.providerName) === providerName);
  return scoped.length > 0 ? scoped : models;
};

const detectedCatalogSlug = (items: ApiTrackedItem[], model: string | null): string | undefined => {
  if (!model) return undefined;
  const key = catalogKey(model);
  return items.find((item) => {
    const slug = catalogKey(item.slug);
    const name = catalogKey(item.name);
    return slug === key || name === key || key.endsWith(`-${slug}`);
  })?.slug;
};

const canUseRatingForm = (parsed: ParsedArgs, io: CliIo): boolean =>
  loginUsesHumanOutput(parsed, io) && io.form !== undefined && !parsed.flags.has("no-input");

const completedForm = async (
  parsed: ParsedArgs,
  io: CliIo,
  title: string,
  fields: readonly TerminalFormField[],
  submitLabel: string
): Promise<Record<string, string> | undefined> => {
  if (!io.form || parsed.flags.has("no-input")) return undefined;
  const result = await io.form(title, fields, {
    color: loginUsesColor(parsed, io),
    submitLabel,
    cancelLabel: "skip today"
  });
  if (result === undefined) throw new CliCancelledError();
  return result;
};

const parseRating = (value: string | undefined): number | null => {
  const rating = Number(value);
  return Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null;
};

const skipRatingToday = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const now = io.now?.() ?? Date.now();
  const seconds = Math.max(1, Math.ceil((nextLocalDay(now) - now) / 1_000));
  const state = await store.deferRate(seconds, now);
  const body = { skipped: true, nextAllowedAt: state.rate.nextAllowedAt };
  writeResult(parsed, io, body, (style) => {
    io.stdout.write(`\n  ${style.dim("Skipped for today. I'll check in again tomorrow; nothing was submitted.")}\n\n`);
  });
  return 0;
};

const runRateSubmit = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const credential = await requireCredential(parsed, store, io);
  if (!credential) return 1;
  const state = await store.getState();
  const pending = state.events.filter((event) => state.pendingEventIds.includes(event.id));
  const selectedId = flagText(parsed.flags, "event-id");
  const selected = selectedId ? pending.find((event) => event.id === selectedId) : pending.at(-1);
  if (!selected) {
    writeCommandError(parsed, io, "no_pending_session");
    return 1;
  }
  const sessionEvents = selected.sessionHash
    ? pending.filter((event) => event.provider === selected.provider && event.sessionHash === selected.sessionHash)
    : [selected];
  const { model, mixed, attributionEvent } = summarizeSession(sessionEvents, selected.provider);

  const humanOutput = loginUsesHumanOutput(parsed, io);
  const style = loginStyles(parsed, io);
  if (humanOutput) {
    io.stdout.write(`\n  ${style.bold(style.cyan("Rate this session"))}\n`);
    io.stdout.write(`  ${style.dim(`${selected.provider} · ${model ?? "Model confirmation needed"}`)}\n`);
    io.stdout.write(`  ${style.dim("Your prompts, code, transcripts, repositories, paths, and raw session ID are never sent.")}\n\n`);
    if (io.form) io.stdout.write(`  ${style.dim("Two quick ratings. Use ↑/↓ for rows, ←/→ to change, and Enter to submit.")}\n\n`);
  }

  const suppliedRatings = {
    resultQuality: flagText(parsed.flags, "result-quality"),
    usageEfficiency: flagText(parsed.flags, "usage-efficiency")
  };
  if (Object.values(suppliedRatings).some((rating) => rating !== undefined && parseRating(rating) === null)) {
    writeCommandError(parsed, io, "ratings_must_be_integers_1_to_5");
    return 1;
  }

  let confirmedItemSlug = flagText(parsed.flags, "item");
  const weakModelAttribution = model === null
    || mixed
    || attributionEvent.attribution === "session_start"
    || attributionEvent.attribution === "manual";
  const interactiveModelConfirmation = !confirmedItemSlug && canUseRatingForm(parsed, io);
  const needsModelConfirmation = !confirmedItemSlug && weakModelAttribution;
  let modelChoices: TerminalChoice[] = [];
  let detectedItemSlug: string | undefined;
  if (interactiveModelConfirmation || needsModelConfirmation) {
    if (!canUseRatingForm(parsed, io)) {
      writeCommandError(parsed, io, "item_confirmation_required_use_item_slug");
      return 1;
    }
    try {
      const items = providerAwareModelCatalog(await getTrackedItems(fetcherFor(io), credential), selected.provider);
      detectedItemSlug = detectedCatalogSlug(items, model);
      modelChoices = items.map((item) => ({ value: item.slug, label: `${item.name} (${item.providerName})` }));
      if (modelChoices.length === 0) {
        writeCommandError(parsed, io, "model_catalog_empty");
        return 1;
      }
    } catch (error) {
      writeCommandError(parsed, io, error instanceof ApiError ? error.code : "catalog_failed", error instanceof Error ? error.message : undefined);
      return 1;
    }
  }

  const missingResultQuality = !suppliedRatings.resultQuality;
  const missingUsageEfficiency = !suppliedRatings.usageEfficiency;
  let formAnswers: Record<string, string> = {};
  if (interactiveModelConfirmation || missingResultQuality || missingUsageEfficiency) {
    const fields: TerminalFormField[] = [
      ...(interactiveModelConfirmation ? [{
        name: "item",
        label: "Model",
        choices: modelChoices,
        ...(detectedItemSlug ? { initialValue: detectedItemSlug } : {})
      }] : []),
      ...(missingResultQuality ? [{
        name: "resultQuality",
        label: "How good was the result?",
        choices: RESULT_QUALITY_CHOICES,
        initialValue: suppliedRatings.resultQuality ?? "3"
      }] : []),
      ...(missingUsageEfficiency ? [{
        name: "usageEfficiency",
        label: "Did progress feel worth the usage?",
        choices: USAGE_EFFICIENCY_CHOICES,
        initialValue: suppliedRatings.usageEfficiency ?? "3"
      }] : [])
    ];
    let form: Record<string, string> | undefined;
    try {
      form = await completedForm(parsed, io, "Quick check-in", fields, "send");
    } catch (error) {
      if (error instanceof CliCancelledError) return skipRatingToday(parsed, store, io);
      throw error;
    }
    if (!form) {
      writeCommandError(parsed, io, "rating_answers_required_use_flags");
      return 1;
    }
    formAnswers = form;
    confirmedItemSlug = form.item ?? confirmedItemSlug;
  }

  const resultQuality = parseRating(suppliedRatings.resultQuality) ?? parseRating(formAnswers.resultQuality);
  const usageEfficiency = parseRating(suppliedRatings.usageEfficiency) ?? parseRating(formAnswers.usageEfficiency);
  if (resultQuality === null || usageEfficiency === null) {
    writeCommandError(parsed, io, "ratings_must_be_integers_1_to_5");
    return 1;
  }
  if ((interactiveModelConfirmation || needsModelConfirmation) && !confirmedItemSlug) {
    writeCommandError(parsed, io, "item_confirmation_required_use_item_slug");
    return 1;
  }
  const suppliedTags = flagText(parsed.flags, "tags");
  const tags = (suppliedTags ?? "").split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 6);
  const comment = flagText(parsed.flags, "comment");
  const config = await store.getConfig();
  const safeSessionHash = selected.sessionHash ?? hashSession(config.hmacSecret, selected.id);
  if (!safeSessionHash) {
    writeCommandError(parsed, io, "session_identity_unavailable");
    return 1;
  }
  const payload: Record<string, unknown> = {
    tool: providerTool(selected.provider),
    attribution: confirmedItemSlug ? "user_confirmed" : serverAttribution(attributionEvent, mixed),
    adapterVersion: CLI_VERSION,
    sessionHash: safeSessionHash,
    sessionDurationBucket: durationBucket(sessionEvents),
    resultQualityRating: resultQuality,
    usageEfficiencyRating: usageEfficiency,
    tags,
    // The persisted local event UUID stays stable when a response is lost, so
    // a foreground retry reaches D1 with the same idempotency key.
    clientEventId: selected.id
  };
  if (model) payload.rawModelLabel = model;
  if (confirmedItemSlug) payload.confirmedItemSlug = confirmedItemSlug;
  if (comment) payload.shortComment = comment.slice(0, 500);
  if (humanOutput && io.form && !parsed.flags.has("no-input")) {
    io.stdout.write(`\n  ${style.dim("Submitting rating…")}\n`);
  }
  try {
    let result: Record<string, unknown>;
    try {
      result = await submitFeedback(fetcherFor(io), credential, payload);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const challenge = cliVerificationDetails(error, credential.serverUrl, io.now?.() ?? Date.now());
      if (!challenge) throw error;
      const proof = await waitForCliBrowserProof(parsed, credential, io, challenge);
      result = await submitFeedback(fetcherFor(io), credential, { ...payload, ...proof });
    }
    const completedAt = io.now?.() ?? Date.now();
    await store.completePending(sessionEvents.map((event) => event.id), nextLocalDay(completedAt));
    if (humanOutput) {
      io.stdout.write(`\n  ${style.green("✓")} ${style.bold("Rating submitted. Thank you.")}\n\n`);
    } else {
      writeJson(io, { submitted: true, result });
    }
    return 0;
  } catch (error) {
    if (error instanceof ApiError && !humanOutput) {
      writeJson(io, { submitted: false, error: { code: error.code, message: error.message, details: error.details ?? null } });
    } else {
      writeCommandError(parsed, io, error instanceof ApiError ? error.code : "feedback_submission_failed", error instanceof Error ? error.message : undefined);
    }
    return 1;
  }
};

const runRate = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const operation = parsed.positionals[0] ?? (parsed.flags.has("result-quality") || parsed.flags.has("usage-efficiency") || canUseRatingForm(parsed, io) ? "submit" : "show");
  if (operation === "clear") {
    const state = await store.clearRate();
    const body = { nextAllowedAt: state.rate.nextAllowedAt };
    writeResult(parsed, io, body, (style) => io.stdout.write(`\n  ${style.green("✓")} Rating reminder reset.\n\n`));
    return 0;
  }
  if (operation === "defer") {
    const seconds = Number(parsed.positionals[1]);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
      writeCommandError(parsed, io, "invalid_defer_seconds");
      return 1;
    }
    const state = await store.deferRate(seconds, io.now?.() ?? Date.now());
    const body = { nextAllowedAt: state.rate.nextAllowedAt };
    writeResult(parsed, io, body, (style) => io.stdout.write(`\n  ${style.green("✓")} Reminder deferred until ${new Date(body.nextAllowedAt ?? 0).toLocaleString()}.\n\n`));
    return 0;
  }
  if (operation !== "show") {
    if (operation === "submit") return runRateSubmit(parsed, store, io);
    writeCommandError(parsed, io, "invalid_rate_operation");
    return 1;
  }
  const state = await store.getState();
  const body = { nextAllowedAt: state.rate.nextAllowedAt };
  writeResult(parsed, io, body, (style) => {
    io.stdout.write(`\n  ${style.bold("Rating reminder")}  ${body.nextAllowedAt ? new Date(body.nextAllowedAt).toLocaleString() : "Available now"}\n\n`);
  });
  return 0;
};

const runPrompt = async (
  parsed: ParsedArgs,
  store: LocalStore,
  io: CliIo,
  options: { silentWhenIneligible?: boolean } = {}
): Promise<number> => {
  const operation = parsed.positionals[0] ?? "ask";
  if (operation === "never") {
    await store.disablePrompts();
    writeResult(parsed, io, { promptsDisabled: true }, (style) => io.stdout.write(`\n  ${style.green("✓")} Rating reminders are off.\n\n`));
    return 0;
  }
  if (operation !== "ask" && operation !== "status") {
    writeCommandError(parsed, io, "invalid_prompt_operation");
    return 1;
  }
  const now = io.now?.() ?? Date.now();
  if (operation === "status") {
    const decision = decidePrompt(await store.getState(), now);
    writeResult(parsed, io, decision, (style) => io.stdout.write(`\n  ${style.bold("Rating reminder")}  ${decision.eligible ? "Ready" : decision.reason.replaceAll("_", " ")}\n\n`));
    return 0;
  }
  const decision = await store.claimPrompt(now);
  if (!decision.eligible) {
    if (options.silentWhenIneligible) return 0;
    writeResult(parsed, io, decision, (style) => io.stdout.write(`\n  ${style.dim(`No reminder right now: ${decision.reason.replaceAll("_", " ")}.`)}\n\n`));
    return 0;
  }
  if (!canUseRatingForm(parsed, io)) {
    const body = { ...decision, message: "Run `isaiokay rate` to share feedback." };
    writeResult(parsed, io, body, (style) => io.stdout.write(`\n  A session is ready to rate. Run ${style.cyan("isaiokay rate")}.\n\n`));
    return 0;
  }
  const flags = new Map(parsed.flags);
  if (decision.eventId) flags.set("event-id", decision.eventId);
  return runRateSubmit({ ...parsed, positionals: ["submit"], flags }, store, io);
};

const runAdapterCommand = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  if (parsed.command === "uninstall" && parsed.flags.has("purge") && !parsed.flags.has("all") && parsed.positionals[0] !== "all") {
    writeCommandError(parsed, io, "purge_requires_all");
    return 1;
  }
  if (parsed.command === "install") {
    const oneShotRunner = detectOneShotRunner(io.env);
    if (oneShotRunner) {
      writePersistentInstallRequired(parsed, io, oneShotRunner);
      return 1;
    }
  }
  if (parsed.command === "install" && (parsed.flags.has("all") || parsed.positionals[0] === "all")) {
    const config = await store.getConfig();
    const detected = await detectSetupProviders(io, config.adapters);
    const results: Array<{ provider: Provider; installed: boolean; message: string }> = [];
    for (const { provider } of detected) {
      try {
        const { integration } = await installAdapter(store, provider, {
          now: io.now?.() ?? Date.now(),
          home: io.home ?? homedir()
        });
        results.push({ provider, installed: integration.mode === "installed", message: integration.message });
      } catch (error) {
        results.push({ provider, installed: false, message: error instanceof Error ? error.message : "Installation failed." });
      }
    }
    const failed = results.filter((result) => !result.installed);
    writeResult(parsed, io, { detected: detected.map(({ provider }) => provider), results }, (style) => {
      io.stdout.write(`\n  ${style.bold(style.cyan("Install detected integrations"))}\n\n`);
      if (detected.length === 0) {
        io.stdout.write(`  ${style.dim("No supported, unconfigured coding CLIs were detected.")}\n`);
      } else {
        for (const result of results) {
          io.stdout.write(`  ${result.installed ? style.green("✓") : style.red("✖")} ${result.provider.padEnd(10)} ${result.message}\n`);
        }
        io.stdout.write(`\n  ${style.dim(`${results.length - failed.length}/${results.length} integrations installed.`)}\n`);
        io.stdout.write(`  Run ${style.cyan("isaiokay doctor")} to check integration health.\n`);
        io.stdout.write(`  Run ${style.cyan("isaiokay shell install")} once to keep using the normal harness commands.\n`);
      }
      io.stdout.write("\n");
    });
    return failed.length > 0 ? 1 : 0;
  }
  if (parsed.command === "uninstall" && (parsed.flags.has("all") || parsed.positionals[0] === "all")) {
    const home = io.home ?? homedir();
    const config = await store.getConfig();
    const results: Array<{ provider: Provider; removed: boolean; message: string }> = [];
    for (const provider of PROVIDERS) {
      try {
        const { integration } = await uninstallAdapter(store, provider, { home });
        results.push({ provider, removed: true, message: integration.message });
      } catch (error) {
        results.push({ provider, removed: false, message: error instanceof Error ? error.message : "Removal failed." });
      }
    }

    const baseShellOptions = { env: io.env ?? process.env, platform: io.platform ?? process.platform };
    const shellTargets = new Map<string, { name: SupportedShell; path: string; registered: boolean }>();
    for (const entry of config.shellIntegrations) {
      shellTargets.set(entry.path, { name: entry.shell, path: entry.path, registered: true });
    }
    for (const name of SUPPORTED_SHELLS) {
      const path = shellIntegrationPath(name, home, baseShellOptions);
      if (!shellTargets.has(path)) shellTargets.set(path, { name, path, registered: false });
    }
    const shells: Array<{ name: SupportedShell; path: string; removed: boolean; message?: string }> = [];
    for (const target of shellTargets.values()) {
      const options = target.registered && target.name === "powershell"
        ? { ...baseShellOptions, profilePath: target.path }
        : baseShellOptions;
      try {
        const result = await uninstallShellIntegration(target.name, home, options);
        await store.unregisterShellIntegration(target.path);
        shells.push({ name: target.name, path: target.path, removed: result.changed });
      } catch (error) {
        shells.push({ name: target.name, path: target.path, removed: false, message: error instanceof Error ? error.message : "Removal failed." });
      }
    }

    const failedIntegrations = results.filter((result) => !result.removed);
    const failedShells = shells.filter((result) => result.message !== undefined);
    const hasFailures = failedIntegrations.length > 0 || failedShells.length > 0;
    let credentialRevocation: "revoked" | "not_signed_in" | "unavailable" | "not_requested" = "not_requested";
    if (parsed.flags.has("purge")) {
      const credential = await store.getCredential();
      if (!credential) credentialRevocation = "not_signed_in";
      else {
        try {
          await revokeCredential(fetcherFor(io), credential);
          credentialRevocation = "revoked";
        } catch {
          credentialRevocation = "unavailable";
        }
      }
      await store.purgeLocalData();
    }
    const body = {
      results,
      shells,
      purged: parsed.flags.has("purge"),
      credentialRevocation,
      packageCommand: "npm uninstall --global @isaiokay/cli"
    };
    writeResult(parsed, io, body, (style) => {
      io.stdout.write(`\n  ${hasFailures ? style.yellow("!") : style.green("✓")} ${style.bold("IsAIokay.com integrations removed.")}\n`);
      for (const shell of shells.filter((result) => result.removed)) io.stdout.write(`  Shell wrapper  ${style.dim(shell.path)}\n`);
      for (const failure of failedIntegrations) {
        io.stdout.write(`  ${style.red("✖")} ${failure.provider}  ${failure.message}\n`);
      }
      for (const shell of failedShells) io.stdout.write(`  ${style.red("✖")} shell  ${shell.path}: ${shell.message}\n`);
      if (parsed.flags.has("purge")) {
        io.stdout.write(`  Local data  ${style.green("removed")}${credentialRevocation === "unavailable" ? style.dim(" (server revocation was unavailable)") : ""}\n`);
      }
      io.stdout.write(`\n  Remove the CLI package:\n  ${style.cyan("npm uninstall --global @isaiokay/cli")}\n\n`);
    });
    return hasFailures ? 1 : 0;
  }
  const provider = parseProvider(parsed.positionals[0]);
  if (provider === null) {
    writeCommandError(parsed, io, "invalid_provider");
    return 1;
  }
  if (parsed.command === "install") {
    const { plan, integration } = await installAdapter(store, provider, {
      now: io.now?.() ?? Date.now(),
      home: io.home ?? homedir()
    });
    const body = { registered: true, ...plan, integration };
    writeResult(parsed, io, body, (style) => {
      const automatic = integration.mode === "installed";
      io.stdout.write(`\n  ${automatic ? style.green("✓") : style.yellow("!")} ${style.bold(`${provider} ${automatic ? "installed" : "requires manual setup"}.`)}\n`);
      io.stdout.write(`  ${plan.reason}\n`);
      if (!automatic) io.stdout.write(`  Command  ${style.cyan(plan.hookCommand)}\n`);
      io.stdout.write(`\n  Next step: ${style.cyan(`isaiokay doctor ${provider}`)}\n`);
      io.stdout.write(`  Automatic questionnaire: ${style.cyan("isaiokay shell install")}\n\n`);
    });
    return 0;
  }
  const { plan, integration } = await uninstallAdapter(store, provider, { home: io.home ?? homedir() });
  const body = { registered: false, ...plan, integration };
  writeResult(parsed, io, body, (style) => io.stdout.write(`\n  ${style.green("✓")} ${style.bold(`${provider} integration removed.`)}\n\n`));
  return 0;
};

const runDoctor = async (parsed: ParsedArgs, store: LocalStore, io: CliIo): Promise<number> => {
  const requested = parsed.positionals[0];
  const providers = requested === undefined ? PROVIDERS : [parseProvider(requested)].filter((provider): provider is Provider => provider !== null);
  if (providers.length === 0) {
    writeCommandError(parsed, io, "invalid_provider");
    return 1;
  }
  const results = await Promise.all(providers.map((provider) => doctorAdapter(store, provider)));
  writeResult(parsed, io, { results }, (style) => {
    io.stdout.write(`\n  ${style.bold(style.cyan("Integration health"))}\n\n`);
    for (const result of results) {
      const healthy = result.registered && (result.mode !== "install" || result.ownedIntegrationFound);
      const marker = healthy ? style.green("✓") : result.mode === "install" ? style.yellow("!") : style.dim("·");
      io.stdout.write(`  ${marker} ${result.provider.padEnd(10)} ${result.message}\n`);
    }
    io.stdout.write(`\n  ${style.dim("Run `isaiokay install <provider>` to repair an automatic integration.")}\n\n`);
  });
  return 0;
};

export const runCli = async (argv: string[], io: CliIo): Promise<number> => {
  const parsed = parseArgs(argv);
  if (parsed.command === "--version" || parsed.command === "-V") {
    io.stdout.write(`${CLI_VERSION}\n`);
    return 0;
  }
  if (parsed.command === undefined && io.form) {
    const defaultParsed: ParsedArgs = { ...parsed, command: "status" };
    const paths = resolveStoragePaths({ env: io.env, home: io.home });
    const store = new LocalStore(paths);
    try {
      const [config, state, credential] = await Promise.all([store.getConfig(), store.getState(), store.getCredential()]);
      const now = io.now?.() ?? Date.now();
      const hasPendingSession = state.events.some((event) => state.pendingEventIds.includes(event.id));
      if (config.onboardingCompletedAt === null) {
        return await runSetup({ ...parsed, command: "setup" }, store, io);
      }
      if (hasPendingSession && credential && credential.expiresAt > now) {
        return await runRate({ ...parsed, command: "rate" }, store, io);
      }
      return await runStatus(defaultParsed, store, io);
    } catch {
      writeCommandError(defaultParsed, io, "local_state_unavailable");
      return 1;
    }
  }
  if (parsed.command === undefined || parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    const requested = parsed.command === "help" ? parsed.positionals[0] : undefined;
    if (requested && !COMMAND_HELP[requested]) {
      writeArgumentError(parsed, io, `Unknown command: ${requested}`, "unknown_command");
      return 1;
    }
    writeHelp(parsed, io, requested);
    return 0;
  }
  if (!COMMAND_FLAGS[parsed.command]) {
    writeArgumentError(parsed, io, `Unknown command: ${parsed.command}`, "unknown_command");
    return 1;
  }
  if (parsed.flags.has("help")) {
    writeHelp(parsed, io, parsed.command);
    return 0;
  }
  const allowedFlags = new Set([...GLOBAL_FLAGS, ...(COMMAND_FLAGS[parsed.command] ?? [])]);
  const unknownFlag = [...parsed.flags.keys()].find((flag) => !allowedFlags.has(flag));
  if (unknownFlag) {
    writeArgumentError(parsed, io, `Unknown option: --${unknownFlag}`, "unknown_option");
    return parsed.command === "hook" ? 0 : 1;
  }
  const paths = resolveStoragePaths({
    configDir: flagText(parsed.flags, "config-dir"),
    stateDir: flagText(parsed.flags, "state-dir"),
    env: io.env,
    home: io.home
  });
  const store = new LocalStore(paths);
  try {
    switch (parsed.command) {
      case "hook": return await runHook(parsed, store, io);
      case "run": return await runHarness(parsed, store, io);
      case "shell": return await runShellIntegration(parsed, store, io);
      case "install":
      case "uninstall": return await runAdapterCommand(parsed, store, io);
      case "doctor": return await runDoctor(parsed, store, io);
      case "config": return await runConfig(parsed, store, io);
      case "setup": return await runSetup(parsed, store, io);
      case "login": return await runLogin(parsed, store, io);
      case "authorize": return await runAuthorize(parsed, store, io);
      case "logout": return await runLogout(parsed, store, io);
      case "allowance": return await runAllowance(parsed, store, io);
      case "status": return await runStatus(parsed, store, io);
      case "pending": return await runPending(parsed, store, io);
      case "prompt": return await runPrompt(parsed, store, io);
      case "rate": return await runRate(parsed, store, io);
      default: return 1;
    }
  } catch (error) {
    if (error instanceof CliCancelledError) {
      if (loginUsesHumanOutput(parsed, io)) {
        const style = loginStyles(parsed, io);
        io.stdout.write(`\n  ${style.yellow("!")} Rating cancelled. Nothing was submitted.\n\n`);
      }
      return 130;
    }
    writeCommandError(parsed, io, "local_state_unavailable");
    return parsed.command === "hook" ? 0 : 1;
  }
};
