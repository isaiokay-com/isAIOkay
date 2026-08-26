import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteJson, pathExists } from "./storage.js";
import type { Provider } from "./types.js";

export interface IntegrationResult {
  provider: Provider;
  mode: "installed" | "manual";
  path: string | null;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readObject = async (path: string): Promise<Record<string, unknown>> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error("configuration root is not an object");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Refusing to overwrite malformed provider configuration at ${path}.`);
  }
};

const hookMarker = (provider: Provider): string => `isaiokay hook --provider ${provider}`;
const hookCommand = (provider: Provider, executable: string, silent = false): string =>
  `${executable} hook --provider ${provider} --${silent ? "silent" : "quiet"}`;

export const resolveGrokHome = (home: string, env: NodeJS.ProcessEnv): string => {
  const configured = env.GROK_HOME?.trim();
  return configured ? resolve(configured) : join(home, ".grok");
};

export const resolveKimiHome = (home: string, env: NodeJS.ProcessEnv): string => {
  const configured = env.KIMI_CODE_HOME?.trim();
  return configured ? resolve(configured) : join(home, ".kimi-code");
};

const mergeCursorHooks = async (
  path: string,
  executable: string,
  remove: boolean
): Promise<void> => {
  if (remove && !(await pathExists(path))) return;
  const root = await readObject(path);
  const existingHooks = isRecord(root.hooks) ? root.hooks : {};
  const nextHooks: Record<string, unknown> = { ...existingHooks };
  for (const event of ["sessionStart", "stop"]) {
    const handlers = Array.isArray(existingHooks[event]) ? existingHooks[event] as unknown[] : [];
    const filtered = handlers.filter((handler) => !(
      isRecord(handler) && typeof handler.command === "string" && handler.command.includes(hookMarker("cursor"))
    ));
    if (!remove) filtered.push({ command: hookCommand("cursor", executable), timeout: 3 });
    if (filtered.length > 0) nextHooks[event] = filtered;
    else delete nextHooks[event];
  }
  const next: Record<string, unknown> = { ...root, hooks: nextHooks };
  if (!remove && next.version === undefined) next.version = 1;
  if (Object.keys(nextHooks).length === 0 && !Object.prototype.hasOwnProperty.call(root, "hooks")) delete next.hooks;
  await atomicWriteJson(path, next);
};

const mergeClaudeCompatibleHooks = async (
  path: string,
  provider: "codex" | "claude" | "qwen",
  executable: string,
  remove: boolean
): Promise<void> => {
  if (remove && !(await pathExists(path))) return;
  const root = await readObject(path);
  const existingHooks = isRecord(root.hooks) ? root.hooks : {};
  const events = ["SessionStart", "Stop", "SessionEnd"];
  const nextHooks: Record<string, unknown> = { ...existingHooks };
  for (const event of events) {
    const groups = Array.isArray(existingHooks[event]) ? existingHooks[event] as unknown[] : [];
    const filtered = groups.flatMap((group): unknown[] => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks.filter((handler) => !(
        isRecord(handler) && typeof handler.command === "string" && handler.command.includes(hookMarker(provider))
      ));
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (!remove) filtered.push({
      hooks: [{
        type: "command",
        command: hookCommand(provider, executable),
        timeout: provider === "qwen" ? (event === "SessionEnd" ? 3_000 : 2_000) : (event === "SessionEnd" ? 3 : 2)
      }]
    });
    if (filtered.length > 0) nextHooks[event] = filtered;
    else delete nextHooks[event];
  }
  const next: Record<string, unknown> = { ...root, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0 && !Object.prototype.hasOwnProperty.call(root, "hooks")) delete next.hooks;
  await atomicWriteJson(path, next);
};

const KIMI_START_MARKER = "# >>> isaiokay lifecycle hooks >>>";
const KIMI_END_MARKER = "# <<< isaiokay lifecycle hooks <<<";
const KIMI_PREFIX_METADATA = "# isaiokay-prefixed-newline = ";

const kimiHookBlock = (executable: string, prefixedNewline: boolean, newline: string): string => [
  KIMI_START_MARKER,
  `${KIMI_PREFIX_METADATA}${prefixedNewline ? "true" : "false"}`,
  "[[hooks]]",
  'event = "SessionStart"',
  `command = ${JSON.stringify(hookCommand("kimi", executable, true))}`,
  "timeout = 2",
  "",
  "[[hooks]]",
  'event = "Stop"',
  `command = ${JSON.stringify(hookCommand("kimi", executable, true))}`,
  "timeout = 2",
  "",
  "[[hooks]]",
  'event = "SessionEnd"',
  `command = ${JSON.stringify(hookCommand("kimi", executable, true))}`,
  "timeout = 2",
  KIMI_END_MARKER
].join(newline);

const markerCount = (source: string, marker: string): number => source.split(marker).length - 1;

const atomicWriteProviderText = async (file: string, text: string): Promise<void> => {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const target = info?.isSymbolicLink() ? await realpath(file) : file;
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await stat(target).catch(() => null);
  const mode = existing ? existing.mode & 0o777 : 0o600;
  const temporary = join(directory, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporary, target);
    await chmod(target, mode).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const mergeKimiHooks = async (path: string, executable: string, remove: boolean): Promise<void> => {
  if (remove && !(await pathExists(path))) return;
  let source = "";
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const starts = markerCount(source, KIMI_START_MARKER);
  const ends = markerCount(source, KIMI_END_MARKER);
  if (starts !== ends || starts > 1) {
    throw new Error(`Refusing to edit malformed IsAIokay.com hook markers at ${path}.`);
  }
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  if (starts === 1) {
    const start = source.indexOf(KIMI_START_MARKER);
    const endMarker = source.indexOf(KIMI_END_MARKER, start + KIMI_START_MARKER.length);
    if (endMarker === -1) {
      throw new Error(`Refusing to edit malformed IsAIokay.com hook markers at ${path}.`);
    }
    const end = endMarker + KIMI_END_MARKER.length;
    const owned = source.slice(start, end);
    const metadata = owned.match(/^# isaiokay-prefixed-newline = (true|false)\r?$/mu)?.[1];
    if (metadata === undefined) {
      throw new Error(`Refusing to edit malformed IsAIokay.com hook metadata at ${path}.`);
    }
    if (!remove) {
      const next = `${source.slice(0, start)}${kimiHookBlock(executable, metadata === "true", newline)}${source.slice(end)}`;
      if (next !== source) await atomicWriteProviderText(path, next);
      return;
    }
    let before = source.slice(0, start);
    if (metadata === "true" && before.endsWith(newline)) before = before.slice(0, -newline.length);
    const afterMarker = source.slice(end);
    const after = afterMarker.startsWith(newline) ? afterMarker.slice(newline.length) : afterMarker;
    const next = `${before}${after}`;
    if (next !== source) await atomicWriteProviderText(path, next);
    return;
  }
  if (remove) return;
  const prefixedNewline = source.length > 0 && !source.endsWith("\n");
  await atomicWriteProviderText(path, `${source}${prefixedNewline ? newline : ""}${kimiHookBlock(executable, prefixedNewline, newline)}${newline}`);
};

const mergeGeminiHooks = async (
  path: string,
  executable: string,
  remove: boolean
): Promise<void> => {
  if (remove && !(await pathExists(path))) return;
  const root = await readObject(path);
  const existingHooks = isRecord(root.hooks) ? root.hooks : {};
  const nextHooks: Record<string, unknown> = { ...existingHooks };
  for (const event of ["BeforeModel", "AfterAgent"]) {
    const groups = Array.isArray(existingHooks[event]) ? existingHooks[event] as unknown[] : [];
    const filtered = groups.flatMap((group): unknown[] => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks.filter((handler) => !(
        isRecord(handler) && typeof handler.command === "string" && handler.command.includes(hookMarker("gemini"))
      ));
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (!remove) filtered.push({
      matcher: "*",
      hooks: [{
        name: "isaiokay-daily-check-in",
        type: "command",
        command: hookCommand("gemini", executable),
        timeout: 2_000,
        description: "Records minimal local activity and may show one daily feedback reminder."
      }]
    });
    if (filtered.length > 0) nextHooks[event] = filtered;
    else delete nextHooks[event];
  }
  const next: Record<string, unknown> = { ...root, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0 && !Object.prototype.hasOwnProperty.call(root, "hooks")) delete next.hooks;
  await atomicWriteJson(path, next);
};

const openCodePlugin = (executable: string): string => `// Installed by isaiokay. Contains no credential and performs no network request.
export const IsAiOkay = async ({ client }) => {
  const messages = new Map();
  const parents = new Map();
  const rootSession = (sessionID) => {
    const visited = new Set();
    let current = sessionID;
    while (parents.has(current) && !visited.has(current)) {
      visited.add(current);
      current = parents.get(current);
    }
    return current;
  };
  const invoke = async (payload) => {
    const child = Bun.spawn(${JSON.stringify([executable, "hook", "--provider", "opencode", "--quiet"])}, {
      stdin: JSON.stringify(payload), stdout: "pipe", stderr: "ignore"
    });
    const output = await new Response(child.stdout).text();
    await child.exited;
    const message = JSON.parse(output || "{}").systemMessage;
    if (typeof message === "string") await client.tui.showToast({ body: { message, variant: "info" } });
  };
  return {
    event: async ({ event }) => {
      try {
        if (event?.type === "session.created" || event?.type === "session.updated") {
          const info = event.properties?.info;
          if (typeof info?.id === "string") {
            if (typeof info.parentID === "string") parents.set(info.id, info.parentID);
          }
          return;
        }
        if (event?.type === "message.updated") {
          const info = event.properties?.info;
          if (
            info?.role === "assistant" && info.summary !== true &&
            typeof info.id === "string" && typeof info.sessionID === "string" &&
            typeof info.providerID === "string" && typeof info.modelID === "string"
          ) {
            const sessionMessages = messages.get(info.sessionID) || new Map();
            sessionMessages.set(info.id, {
              providerID: info.providerID,
              modelID: info.modelID,
              variant: typeof info.variant === "string" ? info.variant : null,
              tokens: info.tokens && typeof info.tokens === "object" ? info.tokens : null
            });
            messages.set(info.sessionID, sessionMessages);
          }
          return;
        }
        if (event?.type === "session.deleted") {
          const sessionID = event.properties?.info?.id;
          if (typeof sessionID === "string") {
            messages.delete(sessionID);
            parents.delete(sessionID);
          }
          return;
        }
        if (event?.type !== "session.idle") return;
        const sessionID = event.properties?.sessionID;
        if (typeof sessionID !== "string") return;
        if (rootSession(sessionID) !== sessionID) return;
        const relatedSessions = [...new Set([...messages.keys(), ...parents.keys()])]
          .filter((candidate) => rootSession(candidate) === sessionID);
        const observed = new Map();
        for (const relatedSession of relatedSessions) {
          for (const [messageID, model] of messages.get(relatedSession)?.entries() || []) {
            observed.set(model.providerID + "/" + model.modelID, model);
            if (model.tokens) {
              await invoke({
                event: "isaiokay.opencode.usage",
                sessionID,
                messageID,
                ...model,
                querySource: relatedSession === sessionID ? "main" : "subagent"
              });
            }
          }
        }
        for (const model of observed.values()) {
          await invoke({ event: "isaiokay.opencode.model", sessionID, providerID: model.providerID, modelID: model.modelID });
        }
        await invoke({ event: "session.idle", sessionID });
        for (const relatedSession of relatedSessions) {
          messages.delete(relatedSession);
          parents.delete(relatedSession);
        }
      } catch {}
    }
  };
};
`;

const ampPlugin = (executable: string): string => `// Installed by isaiokay. Contains no credential and performs no network request.
import type { PluginAPI } from "@ampcode/plugin";

export const description = "Private, once-daily AI coding experience check-in.";

export default function IsAiOkay(amp: PluginAPI) {
  amp.on("agent.end", async (event, ctx) => {
    try {
      const child = Bun.spawn(${JSON.stringify([executable, "hook", "--provider", "amp", "--quiet"])}, {
        stdin: JSON.stringify({ event: "agent.end", thread_id: event.thread.id }),
        stdout: "pipe",
        stderr: "ignore"
      });
      const output = await new Response(child.stdout).text();
      await child.exited;
      const message = JSON.parse(output || "{}").systemMessage;
      if (typeof message === "string") await ctx.ui.notify(message);
    } catch {}
  });
}
`;

export const installOwnedIntegration = async (
  provider: Provider,
  home: string,
  executable = "isaiokay",
  env: NodeJS.ProcessEnv = {}
): Promise<IntegrationResult> => {
  if (provider === "codex" || provider === "claude" || provider === "qwen") {
    const path = provider === "codex"
      ? join(home, ".codex", "hooks.json")
      : provider === "claude"
        ? join(home, ".claude", "settings.json")
        : join(home, ".qwen", "settings.json");
    await mergeClaudeCompatibleHooks(path, provider, executable, false);
    return { provider, mode: "installed", path, message: "Lifecycle hooks installed. Review and trust them in the host tool when prompted." };
  }
  if (provider === "kimi") {
    const path = join(resolveKimiHome(home, env), "config.toml");
    await mergeKimiHooks(path, executable, false);
    return { provider, mode: "installed", path, message: "Kimi Code lifecycle hooks were added without changing existing TOML settings. The documented start model is preselected but remains confirmable." };
  }
  if (provider === "cursor") {
    const path = join(home, ".cursor", "hooks.json");
    await mergeCursorHooks(path, executable, false);
    return { provider, mode: "installed", path, message: "Cursor sessionStart and stop hooks were installed without replacing existing hooks." };
  }
  if (provider === "gemini") {
    const path = join(home, ".gemini", "settings.json");
    await mergeGeminiHooks(path, executable, false);
    return { provider, mode: "installed", path, message: "Gemini BeforeModel and AfterAgent hooks were installed without replacing existing settings." };
  }
  if (provider === "copilot") {
    const path = join(home, ".copilot", "hooks", "isaiokay.json");
    await atomicWriteJson(path, {
      version: 1,
      hooks: {
        agentStop: [{ type: "command", command: hookCommand(provider, executable), timeoutSec: 3 }],
        sessionEnd: [{ type: "command", command: hookCommand(provider, executable), timeoutSec: 3 }]
      }
    });
    return { provider, mode: "installed", path, message: "Isolated Copilot CLI agentStop and SessionEnd hooks were installed. Model confirmation remains required." };
  }
  if (provider === "opencode") {
    const path = join(home, ".config", "opencode", "plugins", "isaiokay.js");
    await mkdir(join(home, ".config", "opencode", "plugins"), { recursive: true, mode: 0o700 });
    await writeFile(path, openCodePlugin(executable), { encoding: "utf8", mode: 0o600 });
    return { provider, mode: "installed", path, message: "An isolated OpenCode v1 event plugin was installed." };
  }
  if (provider === "amp") {
    const path = join(home, ".config", "amp", "plugins", "isaiokay.ts");
    await mkdir(join(home, ".config", "amp", "plugins"), { recursive: true, mode: 0o700 });
    await writeFile(path, ampPlugin(executable), { encoding: "utf8", mode: 0o600 });
    return { provider, mode: "installed", path, message: "An isolated Amp agent.end plugin was installed. Reload Amp plugins if Amp is already open." };
  }
  if (provider === "grok") {
    const path = join(resolveGrokHome(home, env), "hooks", "isaiokay.json");
    await atomicWriteJson(path, {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: hookCommand(provider, executable), timeout: 2 }] }],
        Stop: [{ hooks: [{ type: "command", command: hookCommand(provider, executable), timeout: 2 }] }]
      }
    });
    return { provider, mode: "installed", path, message: "An isolated Grok Build SessionStart and Stop hook file was installed." };
  }
  return {
    provider,
    mode: "manual",
    path: null,
    message: "This provider requires its documented manual bridge; no provider configuration was changed."
  };
};

export const uninstallOwnedIntegration = async (
  provider: Provider,
  home: string,
  env: NodeJS.ProcessEnv = {}
): Promise<IntegrationResult> => {
  if (provider === "codex" || provider === "claude" || provider === "qwen") {
    const path = provider === "codex"
      ? join(home, ".codex", "hooks.json")
      : provider === "claude"
        ? join(home, ".claude", "settings.json")
        : join(home, ".qwen", "settings.json");
    await mergeClaudeCompatibleHooks(path, provider, "isaiokay", true);
    return { provider, mode: "installed", path, message: "Only IsAIokay.com hook handlers were removed." };
  }
  if (provider === "kimi") {
    const path = join(resolveKimiHome(home, env), "config.toml");
    await mergeKimiHooks(path, "isaiokay", true);
    return { provider, mode: "installed", path, message: "Only the owned IsAIokay.com Kimi hook block was removed." };
  }
  if (provider === "cursor") {
    const path = join(home, ".cursor", "hooks.json");
    await mergeCursorHooks(path, "isaiokay", true);
    return { provider, mode: "installed", path, message: "Only IsAIokay.com Cursor hook handlers were removed." };
  }
  if (provider === "gemini") {
    const path = join(home, ".gemini", "settings.json");
    await mergeGeminiHooks(path, "isaiokay", true);
    return { provider, mode: "installed", path, message: "Only IsAIokay.com Gemini hook handlers were removed." };
  }
  if (provider === "copilot") {
    const path = join(home, ".copilot", "hooks", "isaiokay.json");
    await rm(path, { force: true });
    return { provider, mode: "installed", path, message: "The isolated Copilot CLI hook was removed." };
  }
  if (provider === "opencode") {
    const path = join(home, ".config", "opencode", "plugins", "isaiokay.js");
    await rm(path, { force: true });
    return { provider, mode: "installed", path, message: "The isolated OpenCode plugin was removed." };
  }
  if (provider === "amp") {
    const path = join(home, ".config", "amp", "plugins", "isaiokay.ts");
    await rm(path, { force: true });
    return { provider, mode: "installed", path, message: "The isolated Amp plugin was removed." };
  }
  if (provider === "grok") {
    const path = join(resolveGrokHome(home, env), "hooks", "isaiokay.json");
    await rm(path, { force: true });
    return { provider, mode: "installed", path, message: "The isolated Grok Build hook file was removed." };
  }
  return { provider, mode: "manual", path: null, message: "No provider-owned file was changed." };
};
