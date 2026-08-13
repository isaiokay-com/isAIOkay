import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  normalizeAider,
  normalizeAmp,
  normalizeClaude,
  normalizeCline,
  normalizeCodex,
  normalizeCopilot,
  normalizeCursor,
  normalizeGemini,
  normalizeGrok,
  normalizeKimi,
  normalizeMuse,
  normalizeOpenCode,
  normalizeQwen,
  normalizeWindsurf
} from "./normalizers.js";
import { installOwnedIntegration, resolveGrokHome, resolveKimiHome, uninstallOwnedIntegration, type IntegrationResult } from "./integrations.js";
import { pathExists, type LocalStore } from "./storage.js";
import type { AdapterPlan, DoctorResult, Provider, ProviderAdapter } from "./types.js";

/**
 * Tools whose hook/plugin schema is stable enough that `install` can attach an
 * app-owned integration file. Everything else stays an explicit manual or
 * bridge flow so the CLI never mutates an unverified host configuration.
 */
const AUTO_INSTALL_PROVIDERS = new Set<Provider>(["codex", "claude", "cursor", "opencode", "gemini", "copilot", "amp", "grok", "qwen", "kimi"]);
const BRIDGE_PROVIDERS = new Set<Provider>(["cline", "windsurf"]);

const planModeFor = (provider: Provider): AdapterPlan["mode"] => {
  if (AUTO_INSTALL_PROVIDERS.has(provider)) return "install";
  if (BRIDGE_PROVIDERS.has(provider)) return "bridge";
  return "manual";
};

const providerConfigCandidates = (provider: Provider, home = homedir(), env: NodeJS.ProcessEnv = {}): string[] => {
  switch (provider) {
    case "codex":
      return [join(home, ".codex", "config.toml")];
    case "claude":
      return [join(home, ".claude", "settings.json"), join(home, ".claude", "settings.local.json")];
    case "cursor":
      return [join(home, ".cursor", "hooks.json")];
    case "opencode":
      return [join(home, ".config", "opencode", "opencode.json"), join(home, ".config", "opencode", "opencode.jsonc")];
    case "gemini":
      return [join(home, ".gemini", "settings.json")];
    case "amp":
      return [join(home, ".config", "amp")];
    case "grok":
      return [join(resolveGrokHome(home, env), "hooks")];
    case "qwen":
      return [join(home, ".qwen", "settings.json")];
    case "kimi":
      return [join(resolveKimiHome(home, env), "config.toml")];
    case "muse":
      return [];
    case "copilot":
    case "cline":
    case "windsurf":
    case "aider":
      return [];
  }
};

/** The app-owned file `install` creates for an auto-install provider. */
const ownedIntegrationPath = (provider: Provider, home: string, env: NodeJS.ProcessEnv = {}): string | null => {
  switch (provider) {
    case "codex": return join(home, ".codex", "hooks.json");
    case "claude": return join(home, ".claude", "settings.json");
    case "copilot": return join(home, ".copilot", "hooks", "isaiokay.json");
    case "opencode": return join(home, ".config", "opencode", "plugins", "isaiokay.js");
    case "gemini": return join(home, ".gemini", "settings.json");
    case "amp": return join(home, ".config", "amp", "plugins", "isaiokay.ts");
    case "cursor": return join(home, ".cursor", "hooks.json");
    case "grok": return join(resolveGrokHome(home, env), "hooks", "isaiokay.json");
    case "qwen": return join(home, ".qwen", "settings.json");
    case "kimi": return join(resolveKimiHome(home, env), "config.toml");
    default: return null;
  }
};

/**
 * Doctor checks only for the CLI's own marker inside merged hook files and the
 * existence of isolated app-owned files. It never parses or retains vendor
 * configuration beyond the owned marker check, and it never uploads anything.
 */
const ownedIntegrationFound = async (provider: Provider, home: string, env: NodeJS.ProcessEnv = {}): Promise<boolean> => {
  const path = ownedIntegrationPath(provider, home, env);
  if (path === null) return false;
  if (provider === "copilot" || provider === "opencode" || provider === "amp" || provider === "grok") return pathExists(path);
  if (!(await pathExists(path))) return false;
  try {
    const text = await readFile(path, "utf8");
    return text.includes(`isaiokay hook --provider ${provider}`);
  } catch {
    return false;
  }
};

const reasonFor = (provider: Provider): string => {
  switch (provider) {
    case "codex": return "Codex lifecycle hooks are installed and managed by this CLI using the documented hooks.json schema.";
    case "claude": return "Claude Code registration accepts SessionStart/Stop/SessionEnd; this CLI merges owned hook groups into settings.json.";
    case "cursor": return "Cursor sessionStart and stop hooks are merged into its documented global hooks.json; Auto remains an opaque router and no follow-up prompt is injected.";
    case "opencode": return "An isolated OpenCode v1 plugin is installed; the CLI requires the privacy-safe bridge envelope and never parses request content.";
    case "copilot": return "An isolated Copilot CLI agentStop/SessionEnd hook records turn activity without injecting messages; model confirmation remains required.";
    case "gemini": return "Gemini BeforeModel records exact model activity and AfterAgent can display one user-only daily reminder; owned groups are merged into settings.json.";
    case "cline": return "Cline terminal task events may be bridged manually; no editor configuration is rewritten by this CLI.";
    case "windsurf": return "Windsurf response events are per-turn and require a manual bridge; no editor configuration is rewritten by this CLI.";
    case "aider": return "Aider is wrapper/manual only; this CLI does not alter Aider configuration.";
    case "amp": return "An isolated Amp agent.end plugin records a minimized thread envelope and uses Amp's native notification UI; model confirmation remains required.";
    case "grok": return "An isolated Grok Build SessionStart/Stop hook file records genuine completed turns without blocking or continuing the agent.";
    case "qwen": return "Qwen Code SessionStart records the documented active model; Stop and SessionEnd provide lifecycle completion without reading conversation content.";
    case "kimi": return "An owned Kimi Code TOML block records SessionStart/Stop/SessionEnd activity and the documented start model; model confirmation remains required because later changes are not observable.";
    case "muse": return "Muse Code uses the foreground wrapper until Meta publishes a stable lifecycle hook contract.";
  }
};

/** Public metadata for callers that want to render only honest adapter states. */
export const providerAdapters: readonly ProviderAdapter[] = [
  { provider: "codex", mode: "install", description: reasonFor("codex"), normalize: normalizeCodex },
  { provider: "claude", mode: "install", description: reasonFor("claude"), normalize: normalizeClaude },
  { provider: "cursor", mode: "install", description: reasonFor("cursor"), normalize: normalizeCursor },
  { provider: "opencode", mode: "install", description: reasonFor("opencode"), normalize: normalizeOpenCode },
  { provider: "gemini", mode: "install", description: reasonFor("gemini"), normalize: normalizeGemini },
  { provider: "copilot", mode: "install", description: reasonFor("copilot"), normalize: normalizeCopilot },
  { provider: "cline", mode: "bridge", description: reasonFor("cline"), normalize: normalizeCline },
  { provider: "windsurf", mode: "bridge", description: reasonFor("windsurf"), normalize: normalizeWindsurf },
  { provider: "aider", mode: "manual", description: reasonFor("aider"), normalize: normalizeAider },
  { provider: "amp", mode: "install", description: reasonFor("amp"), normalize: normalizeAmp },
  { provider: "grok", mode: "install", description: reasonFor("grok"), normalize: normalizeGrok },
  { provider: "qwen", mode: "install", description: reasonFor("qwen"), normalize: normalizeQwen },
  { provider: "kimi", mode: "install", description: reasonFor("kimi"), normalize: normalizeKimi },
  { provider: "muse", mode: "manual", description: reasonFor("muse"), normalize: normalizeMuse }
];

export const getAdapterPlan = (provider: Provider, home = homedir(), env: NodeJS.ProcessEnv = {}): AdapterPlan => ({
  provider,
  mode: planModeFor(provider),
  configCandidates: providerConfigCandidates(provider, home, env),
  hookCommand: `isaiokay hook --provider ${provider}`,
  reason: reasonFor(provider)
});

export interface AdapterInstallResult {
  plan: AdapterPlan;
  integration: IntegrationResult;
}

export const installAdapter = async (
  store: LocalStore,
  provider: Provider,
  options: { now?: number; home?: string; executable?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<AdapterInstallResult> => {
  const now = options.now ?? Date.now();
  const home = options.home ?? homedir();
  const env = options.env ?? {};
  const plan = getAdapterPlan(provider, home, env);
  const integration = plan.mode === "install"
    ? await installOwnedIntegration(provider, home, options.executable ?? "isaiokay", env)
    : { provider, mode: "manual" as const, path: null, message: "This provider requires its documented manual bridge; no provider configuration was changed." };
  if (integration.mode === "installed") await store.registerAdapter(provider, "installed", now);
  return { plan, integration };
};

export const uninstallAdapter = async (
  store: LocalStore,
  provider: Provider,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<AdapterInstallResult> => {
  const home = options.home ?? homedir();
  const env = options.env ?? {};
  const plan = getAdapterPlan(provider, home, env);
  const integration = plan.mode === "install"
    ? await uninstallOwnedIntegration(provider, home, env)
    : { provider, mode: "manual" as const, path: null, message: "No provider-owned file was changed." };
  await store.unregisterAdapter(provider);
  return { plan, integration };
};

export const doctorAdapter = async (store: LocalStore, provider: Provider, home = homedir(), env: NodeJS.ProcessEnv = {}): Promise<DoctorResult> => {
  const [config, owned, ...exists] = await Promise.all([
    store.getConfig(),
    ownedIntegrationFound(provider, home, env),
    ...getAdapterPlan(provider, home, env).configCandidates.map(pathExists)
  ]);
  const plan = getAdapterPlan(provider, home, env);
  return {
    provider,
    mode: plan.mode,
    registered: config.adapters[provider] !== undefined,
    candidateConfigFound: exists.some(Boolean),
    ownedIntegrationFound: owned,
    message: reasonFor(provider)
  };
};
