import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { normalizeModelIdentifier } from "./privacy.js";
import { decidePrompt, type PromptDecision } from "./prompt-policy.js";
import { isSafeShellPath } from "./shell-integration.js";
import type { AdapterRegistration, CliCredential, LocalConfig, LocalState, LocalSubscription, Provider, StoragePaths, StoredEvent, StoredQuotaSnapshot, StoredUsageSlice } from "./types.js";

const MAX_EVENTS = 250;
const MAX_PENDING = 100;
const MAX_USAGE = 10_000;
const MAX_QUOTA = 2_000;
const MAX_PENDING_TELEMETRY = 10_000;
const LOCK_RETRY_MS = 15;
const LOCK_ATTEMPTS = 100;
const STALE_LOCK_MS = 10_000;

const defaultState = (): LocalState => ({
  schemaVersion: 1,
  events: [],
  pendingEventIds: [],
  usage: [],
  pendingUsageIds: [],
  quota: [],
  pendingQuotaIds: [],
  rate: { nextAllowedAt: null, hookReminderShownAt: [], promptShownAt: [], promptsDisabled: false }
});

const defaultConfig = (): LocalConfig => ({
  schemaVersion: 1,
  hmacSecret: randomBytes(32).toString("base64url"),
  onboardingCompletedAt: null,
  adapters: {},
  subscriptions: [],
  subscriptionBindings: {},
  shellIntegrations: []
});

const asFiniteTimestamp = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

const asProvider = (value: unknown): Provider | null =>
  value === "codex" || value === "claude" || value === "cursor" || value === "opencode" || value === "gemini" || value === "copilot" || value === "cline" || value === "windsurf" || value === "aider" || value === "amp" || value === "grok" || value === "qwen" || value === "kimi" || value === "muse"
    ? value
    : null;

const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const isPrivateHash = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const isSafeText = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000_000;
const isPercent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

const asSubscription = (value: unknown): LocalSubscription | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const provider = asProvider(item.provider);
  const billingPeriod = item.billingPeriod;
  const startedAt = item.startedAt === null ? null : asFiniteTimestamp(item.startedAt);
  const endedAt = item.endedAt === null ? null : asFiniteTimestamp(item.endedAt);
  if (
    !isUuid(item.id) || provider === null || !isSafeText(item.providerName, 80) || !isSafeText(item.planLabel, 100) ||
    (item.planSlug !== undefined && (typeof item.planSlug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.planSlug))) ||
    (billingPeriod !== "monthly" && billingPeriod !== "annual" && billingPeriod !== "weekly" && billingPeriod !== "other") ||
    (item.priceMicros !== null && !isCount(item.priceMicros)) || typeof item.currency !== "string" || !/^[A-Z]{3}$/.test(item.currency) ||
    typeof item.aggregateConsent !== "boolean" || (item.startedAt !== null && startedAt === null) || (item.endedAt !== null && endedAt === null) ||
    (startedAt !== null && endedAt !== null && endedAt <= startedAt) ||
    asFiniteTimestamp(item.createdAt) === null || asFiniteTimestamp(item.updatedAt) === null
  ) return null;
  return {
    id: item.id,
    provider,
    providerName: item.providerName,
    planLabel: item.planLabel,
    ...(typeof item.planSlug === "string" ? { planSlug: item.planSlug } : {}),
    billingPeriod,
    priceMicros: item.priceMicros as number | null,
    currency: item.currency,
    aggregateConsent: item.aggregateConsent,
    startedAt,
    endedAt,
    createdAt: item.createdAt as number,
    updatedAt: item.updatedAt as number
  };
};

const asUsageSlice = (value: unknown): StoredUsageSlice | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const provider = asProvider(item.provider);
  const nullableTexts = [item.requestedModel, item.modelFamily, item.modelVersion, item.reasoningEffort, item.modelVariant, item.serviceTier];
  const counts = [item.inputTokens, item.cacheReadTokens, item.cacheWriteTokens, item.outputTokens, item.reasoningTokens];
  if (
    item.schemaVersion !== 1 || !isUuid(item.id) || !isUuid(item.subscriptionId) || provider === null || !isSafeText(item.tool, 40) ||
    (item.sessionHash !== null && !isPrivateHash(item.sessionHash)) || (item.requestHash !== null && !isPrivateHash(item.requestHash)) ||
    !isSafeText(item.reportedModel, 160) || nullableTexts.some((entry) => entry !== null && !isSafeText(entry, 160)) ||
    (item.querySource !== "main" && item.querySource !== "subagent" && item.querySource !== "auxiliary" && item.querySource !== "background" && item.querySource !== "unknown") ||
    (item.granularity !== "request" && item.granularity !== "message" && item.granularity !== "turn" && item.granularity !== "session_model") ||
    (item.attributionQuality !== "exact" && item.attributionQuality !== "inferred" && item.attributionQuality !== "estimated" && item.attributionQuality !== "unknown") ||
    (item.tokenAttributionQuality !== "exact" && item.tokenAttributionQuality !== "inferred" && item.tokenAttributionQuality !== "estimated" && item.tokenAttributionQuality !== "unknown") ||
    (item.modelAttributionQuality !== "exact" && item.modelAttributionQuality !== "inferred" && item.modelAttributionQuality !== "estimated" && item.modelAttributionQuality !== "unknown") ||
    (item.effortAttributionQuality !== "exact" && item.effortAttributionQuality !== "inferred" && item.effortAttributionQuality !== "estimated" && item.effortAttributionQuality !== "unknown") ||
    counts.some((entry) => !isCount(entry)) || counts.reduce<number>((sum, entry) => sum + Number(entry), 0) <= 0 ||
    (item.reportedTotalTokens !== null && !isCount(item.reportedTotalTokens)) || asFiniteTimestamp(item.observedAt) === null || asFiniteTimestamp(item.recordedAt) === null
  ) return null;
  return item as unknown as StoredUsageSlice;
};

const asQuotaSnapshot = (value: unknown): StoredQuotaSnapshot | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const provider = asProvider(item.provider);
  if (
    item.schemaVersion !== 1 || !isUuid(item.id) || !isUuid(item.subscriptionId) || provider === null || !isSafeText(item.quotaScope, 80) ||
    (item.windowKind !== "session" && item.windowKind !== "daily" && item.windowKind !== "weekly" && item.windowKind !== "monthly" && item.windowKind !== "rolling" && item.windowKind !== "unknown") ||
    (item.usedPercent !== null && !isPercent(item.usedPercent)) || (item.remainingPercent !== null && !isPercent(item.remainingPercent)) ||
    (item.usedPercent === null && item.remainingPercent === null) ||
    (item.resetAt !== null && asFiniteTimestamp(item.resetAt) === null) ||
    (item.attributionQuality !== "exact" && item.attributionQuality !== "inferred" && item.attributionQuality !== "estimated" && item.attributionQuality !== "unknown") ||
    asFiniteTimestamp(item.observedAt) === null || asFiniteTimestamp(item.recordedAt) === null
  ) return null;
  return item as unknown as StoredQuotaSnapshot;
};

const asStoredEvent = (value: unknown): StoredEvent | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const provider = asProvider(candidate.provider);
  const attribution = candidate.attribution;
  const model = candidate.model;
  const sessionHash = candidate.sessionHash;
  const shellHash = candidate.shellHash;
  const occurredAt = asFiniteTimestamp(candidate.occurredAt);
  const recordedAt = asFiniteTimestamp(candidate.recordedAt);
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.id) ||
    provider === null ||
    (attribution !== "active_model" && attribution !== "session_start" && attribution !== "explicit_model" && attribution !== "opaque_auto" && attribution !== "documented_model" && attribution !== "before_model" && attribution !== "session_end_unknown" && attribution !== "task_complete" && attribution !== "turn_model" && attribution !== "agent_end" && attribution !== "turn_complete" && attribution !== "manual") ||
    (typeof model !== "string" && model !== null) ||
    (typeof model === "string" && normalizeModelIdentifier(model) !== model) ||
    (typeof sessionHash !== "string" && sessionHash !== null) ||
    (typeof sessionHash === "string" && !/^[A-Za-z0-9_-]{43}$/.test(sessionHash)) ||
    (shellHash !== undefined && (typeof shellHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(shellHash))) ||
    occurredAt === null ||
    recordedAt === null
  ) return null;
  return {
    schemaVersion: 1,
    id: candidate.id,
    provider,
    attribution,
    model,
    sessionHash,
    ...(typeof shellHash === "string" ? { shellHash } : {}),
    occurredAt,
    recordedAt
  };
};

const parseState = (value: unknown): LocalState | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.events) || !Array.isArray(candidate.pendingEventIds)) return null;
  const events = candidate.events.map(asStoredEvent).filter((event): event is StoredEvent => event !== null).slice(-MAX_EVENTS);
  const pendingEventIds = candidate.pendingEventIds.filter((value): value is string => typeof value === "string").slice(-MAX_PENDING);
  const usage = (Array.isArray(candidate.usage) ? candidate.usage : []).map(asUsageSlice).filter((entry): entry is StoredUsageSlice => entry !== null).slice(-MAX_USAGE);
  const retainedUsageIds = new Set(usage.map(({ id }) => id));
  const pendingUsageIds = (Array.isArray(candidate.pendingUsageIds) ? candidate.pendingUsageIds : []).filter((id): id is string => typeof id === "string" && retainedUsageIds.has(id)).slice(-MAX_PENDING_TELEMETRY);
  const quota = (Array.isArray(candidate.quota) ? candidate.quota : []).map(asQuotaSnapshot).filter((entry): entry is StoredQuotaSnapshot => entry !== null).slice(-MAX_QUOTA);
  const retainedQuotaIds = new Set(quota.map(({ id }) => id));
  const pendingQuotaIds = (Array.isArray(candidate.pendingQuotaIds) ? candidate.pendingQuotaIds : []).filter((id): id is string => typeof id === "string" && retainedQuotaIds.has(id)).slice(-MAX_PENDING_TELEMETRY);
  const rateCandidate = candidate.rate;
  const nextAllowedAt = typeof rateCandidate === "object" && rateCandidate !== null && !Array.isArray(rateCandidate)
    ? (rateCandidate as Record<string, unknown>).nextAllowedAt
    : null;
  const rawPromptShownAt = typeof rateCandidate === "object" && rateCandidate !== null && !Array.isArray(rateCandidate)
    ? (rateCandidate as Record<string, unknown>).promptShownAt
    : null;
  const rawHookReminderShownAt = typeof rateCandidate === "object" && rateCandidate !== null && !Array.isArray(rateCandidate)
    ? (rateCandidate as Record<string, unknown>).hookReminderShownAt
    : null;
  const promptShownAt = Array.isArray(rawPromptShownAt)
    ? rawPromptShownAt.map(asFiniteTimestamp).filter((value): value is number => value !== null).slice(-20)
    : [];
  const hookReminderShownAt = Array.isArray(rawHookReminderShownAt)
    ? rawHookReminderShownAt.map(asFiniteTimestamp).filter((value): value is number => value !== null).slice(-20)
    : [];
  const promptsDisabled = typeof rateCandidate === "object" && rateCandidate !== null && !Array.isArray(rateCandidate)
    ? (rateCandidate as Record<string, unknown>).promptsDisabled === true
    : false;
  return {
    schemaVersion: 1,
    events,
    pendingEventIds,
    usage,
    pendingUsageIds,
    quota,
    pendingQuotaIds,
    rate: { nextAllowedAt: asFiniteTimestamp(nextAllowedAt), hookReminderShownAt, promptShownAt, promptsDisabled }
  };
};

const parseConfig = (value: unknown): LocalConfig | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1 || typeof candidate.hmacSecret !== "string" || candidate.hmacSecret.length < 32) return null;
  const rawAdapters = candidate.adapters;
  const adapters: Partial<Record<Provider, AdapterRegistration>> = {};
  if (typeof rawAdapters === "object" && rawAdapters !== null && !Array.isArray(rawAdapters)) {
    for (const [key, value] of Object.entries(rawAdapters)) {
      const provider = asProvider(key);
      if (provider === null || typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      const installedAt = asFiniteTimestamp(entry.installedAt);
      if ((entry.mode === "manual" || entry.mode === "installed") && installedAt !== null) adapters[provider] = { mode: entry.mode, installedAt };
    }
  }
  const subscriptions = (Array.isArray(candidate.subscriptions) ? candidate.subscriptions : [])
    .map(asSubscription).filter((entry): entry is LocalSubscription => entry !== null).slice(-50);
  const subscriptionIds = new Set(subscriptions.map(({ id }) => id));
  const subscriptionBindings: Record<string, string> = {};
  if (typeof candidate.subscriptionBindings === "object" && candidate.subscriptionBindings !== null && !Array.isArray(candidate.subscriptionBindings)) {
    for (const [bindingKey, subscriptionId] of Object.entries(candidate.subscriptionBindings)) {
      if (/^[a-z0-9][a-z0-9._:/@+-]{0,119}$/.test(bindingKey) && typeof subscriptionId === "string" && subscriptionIds.has(subscriptionId)) subscriptionBindings[bindingKey] = subscriptionId;
    }
  }
  const shellIntegrations: LocalConfig["shellIntegrations"] = Array.isArray(candidate.shellIntegrations)
    ? candidate.shellIntegrations.flatMap((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
        const entry = value as Record<string, unknown>;
        const shell = entry.shell;
        if ((shell !== "bash" && shell !== "zsh" && shell !== "fish" && shell !== "powershell") || typeof entry.path !== "string" || !isSafeShellPath(entry.path)) return [];
        return [{ shell: shell as LocalConfig["shellIntegrations"][number]["shell"], path: entry.path }];
      }).slice(-8)
    : [];
  return {
    schemaVersion: 1,
    hmacSecret: candidate.hmacSecret,
    // Configs written before first-run onboarding existed are treated as
    // already onboarded, so an upgrade never launches setup unexpectedly.
    onboardingCompletedAt: candidate.onboardingCompletedAt === undefined
      ? 1
      : asFiniteTimestamp(candidate.onboardingCompletedAt),
    adapters,
    subscriptions,
    subscriptionBindings,
    shellIntegrations
  };
};

const parseCredential = (value: unknown): CliCredential | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.serverUrl !== "string" ||
    !/^https?:\/\/[^\s]+$/.test(candidate.serverUrl) ||
    typeof candidate.accessToken !== "string" ||
    !/^iai_[a-f0-9]{64}$/.test(candidate.accessToken) ||
    asFiniteTimestamp(candidate.expiresAt) === null
  ) return null;
  return {
    schemaVersion: 1,
    serverUrl: candidate.serverUrl.replace(/\/$/, ""),
    accessToken: candidate.accessToken,
    expiresAt: candidate.expiresAt as number
  };
};

const privateDirectory = async (directory: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
};

/** Write via a sibling temporary file and rename, so hooks never leave partial JSON. */
export const atomicWriteJson = async (file: string, value: unknown): Promise<void> => {
  const directory = dirname(file);
  await privateDirectory(directory);
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const readJson = async (file: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
};

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Serialize cross-process read/modify/write operations while keeping replacement atomic. */
const withFileLock = async <T>(file: string, operation: () => Promise<T>): Promise<T> => {
  const lockFile = `${file}.lock`;
  await privateDirectory(dirname(file));
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = await open(lockFile, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const lockStat = await stat(lockFile).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
        await rm(lockFile, { force: true });
        continue;
      }
      await pause(LOCK_RETRY_MS);
    }
  }
  if (!handle) throw new Error(`Timed out waiting for local state lock: ${lockFile}`);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lockFile, { force: true }).catch(() => undefined);
  }
};

export const resolveStoragePaths = (options: {
  configDir?: string | undefined;
  stateDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
} = {}): StoragePaths => {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configRoot = options.configDir ?? env.XDG_CONFIG_HOME ?? join(home, ".config");
  const stateRoot = options.stateDir ?? env.XDG_STATE_HOME ?? join(home, ".local", "state");
  return {
    configFile: join(configRoot, "isaiokay", "config.json"),
    stateFile: join(stateRoot, "isaiokay", "state.json"),
    credentialFile: join(configRoot, "isaiokay", "credential.json")
  };
};

export class LocalStore {
  constructor(readonly paths: StoragePaths) {}

  private mutateConfig(transform: (config: LocalConfig) => LocalConfig): Promise<LocalConfig> {
    return withFileLock(this.paths.configFile, async () => {
      const current = parseConfig(await readJson(this.paths.configFile)) ?? defaultConfig();
      const next = transform(current);
      await atomicWriteJson(this.paths.configFile, next);
      return next;
    });
  }

  private mutateState(transform: (state: LocalState) => LocalState): Promise<LocalState> {
    return withFileLock(this.paths.stateFile, async () => {
      const next = transform(await this.getState());
      await this.saveState(next);
      return next;
    });
  }

  async getConfig(): Promise<LocalConfig> {
    const config = parseConfig(await readJson(this.paths.configFile));
    if (config !== null) return config;
    return withFileLock(this.paths.configFile, async () => {
      const existing = parseConfig(await readJson(this.paths.configFile));
      if (existing !== null) return existing;
      const fresh = defaultConfig();
      await atomicWriteJson(this.paths.configFile, fresh);
      return fresh;
    });
  }

  async getState(): Promise<LocalState> {
    return parseState(await readJson(this.paths.stateFile)) ?? defaultState();
  }

  async saveState(state: LocalState): Promise<void> {
    await atomicWriteJson(this.paths.stateFile, state);
  }

  async getCredential(): Promise<CliCredential | null> {
    return parseCredential(await readJson(this.paths.credentialFile));
  }

  async saveCredential(credential: CliCredential): Promise<void> {
    const parsed = parseCredential(credential);
    if (parsed === null) throw new Error("invalid CLI credential");
    await atomicWriteJson(this.paths.credentialFile, parsed);
  }

  async clearCredential(): Promise<void> {
    await rm(this.paths.credentialFile, { force: true });
  }

  async purgeLocalData(): Promise<void> {
    await Promise.all([
      rm(this.paths.configFile, { force: true }),
      rm(this.paths.credentialFile, { force: true }),
      rm(this.paths.stateFile, { force: true })
    ]);
  }

  async registerShellIntegration(shell: LocalConfig["shellIntegrations"][number]["shell"], path: string): Promise<LocalConfig> {
    if (!isSafeShellPath(path)) throw new Error("invalid shell integration path");
    return this.mutateConfig((config) => ({
      ...config,
      shellIntegrations: [
        ...config.shellIntegrations.filter((entry) => entry.path !== path),
        { shell, path }
      ].slice(-8)
    }));
  }

  async unregisterShellIntegration(path: string): Promise<LocalConfig> {
    return this.mutateConfig((config) => ({
      ...config,
      shellIntegrations: config.shellIntegrations.filter((entry) => entry.path !== path)
    }));
  }

  async completeOnboarding(now = Date.now()): Promise<LocalConfig> {
    return this.mutateConfig((config) => ({ ...config, onboardingCompletedAt: now }));
  }

  async upsertSubscription(subscription: LocalSubscription): Promise<LocalConfig> {
    if (asSubscription(subscription) === null) throw new Error("invalid subscription");
    return this.mutateConfig((config) => ({
      ...config,
      subscriptions: [...config.subscriptions.filter(({ id }) => id !== subscription.id), subscription].slice(-50)
    }));
  }

  async bindSubscription(bindingKey: string, subscriptionId: string): Promise<LocalConfig> {
    return this.mutateConfig((config) => {
      if (!/^[a-z0-9][a-z0-9._:/@+-]{0,119}$/.test(bindingKey)) throw new Error("invalid binding key");
      const harness = asProvider(bindingKey.split(":", 1)[0]);
      const subscription = config.subscriptions.find(({ id, provider: subscriptionProvider }) => id === subscriptionId && (harness === "opencode" || subscriptionProvider === harness));
      if (!subscription) throw new Error("subscription not found");
      return { ...config, subscriptionBindings: { ...config.subscriptionBindings, [bindingKey]: subscriptionId } };
    });
  }

  async recordTelemetry(input: { usage?: StoredUsageSlice[]; quota?: StoredQuotaSnapshot[] }): Promise<LocalState> {
    const usage = input.usage ?? [];
    const quota = input.quota ?? [];
    if (usage.some((entry) => asUsageSlice(entry) === null) || quota.some((entry) => asQuotaSnapshot(entry) === null)) {
      throw new Error("invalid minimized telemetry");
    }
    return this.mutateState((state) => {
      const usageKey = (entry: StoredUsageSlice) => entry.requestHash ? `${entry.provider}:${entry.requestHash}` : entry.id;
      const usageByObservation = new Map(state.usage.map((entry) => [usageKey(entry), entry]));
      const acceptedUsage: StoredUsageSlice[] = [];
      for (const entry of usage) {
        const key = usageKey(entry);
        if (usageByObservation.has(key)) continue;
        usageByObservation.set(key, entry);
        acceptedUsage.push(entry);
      }
      const nextUsage = [...usageByObservation.values()].slice(-MAX_USAGE);
      const quotaKey = (entry: StoredQuotaSnapshot) => `${entry.provider}:${entry.subscriptionId}:${entry.quotaScope}:${entry.observedAt}`;
      const quotaByObservation = new Map(state.quota.map((entry) => [quotaKey(entry), entry]));
      const acceptedQuota: StoredQuotaSnapshot[] = [];
      for (const entry of quota) {
        const key = quotaKey(entry);
        if (quotaByObservation.has(key)) continue;
        quotaByObservation.set(key, entry);
        acceptedQuota.push(entry);
      }
      const nextQuota = [...quotaByObservation.values()].slice(-MAX_QUOTA);
      const usageIds = new Set(nextUsage.map(({ id }) => id));
      const quotaIds = new Set(nextQuota.map(({ id }) => id));
      return {
        ...state,
        usage: nextUsage,
        quota: nextQuota,
        pendingUsageIds: [...state.pendingUsageIds.filter((id) => usageIds.has(id)), ...acceptedUsage.map(({ id }) => id).filter((id) => usageIds.has(id))].slice(-MAX_PENDING_TELEMETRY),
        pendingQuotaIds: [...state.pendingQuotaIds.filter((id) => quotaIds.has(id)), ...acceptedQuota.map(({ id }) => id).filter((id) => quotaIds.has(id))].slice(-MAX_PENDING_TELEMETRY)
      };
    });
  }

  async completeTelemetry(usageIds: string[], quotaIds: string[]): Promise<LocalState> {
    const completedUsage = new Set(usageIds);
    const completedQuota = new Set(quotaIds);
    return this.mutateState((state) => ({
      ...state,
      pendingUsageIds: state.pendingUsageIds.filter((id) => !completedUsage.has(id)),
      pendingQuotaIds: state.pendingQuotaIds.filter((id) => !completedQuota.has(id))
    }));
  }

  async clearTelemetry(includeSubscriptions = false): Promise<void> {
    await this.mutateState((state) => ({
      ...state,
      usage: [],
      pendingUsageIds: [],
      quota: [],
      pendingQuotaIds: []
    }));
    if (includeSubscriptions) {
      await this.mutateConfig((config) => ({ ...config, subscriptions: [], subscriptionBindings: {} }));
    }
  }

  async recordEvent(event: StoredEvent): Promise<LocalState> {
    return this.recordEvents([event]);
  }

  async recordEvents(newEvents: StoredEvent[]): Promise<LocalState> {
    if (newEvents.length === 0 || newEvents.some((event) => asStoredEvent(event) === null)) {
      throw new Error("invalid minimized event");
    }
    return this.mutateState((state) => {
      const events = [...state.events, ...newEvents].slice(-MAX_EVENTS);
      const retainedIds = new Set(events.map((entry) => entry.id));
      const pendingEventIds = [
        ...state.pendingEventIds.filter((id) => retainedIds.has(id)),
        ...newEvents.map(({ id }) => id).filter((id) => retainedIds.has(id))
      ].slice(-MAX_PENDING);
      return { ...state, events, pendingEventIds };
    });
  }

  async clearPending(): Promise<LocalState> {
    return this.mutateState((state) => ({ ...state, pendingEventIds: [] }));
  }

  async deferRate(seconds: number, now = Date.now()): Promise<LocalState> {
    return this.mutateState((state) => ({ ...state, rate: { ...state.rate, nextAllowedAt: now + seconds * 1_000 } }));
  }

  async clearRate(): Promise<LocalState> {
    return this.mutateState((state) => ({
      ...state,
      rate: { nextAllowedAt: null, hookReminderShownAt: [], promptShownAt: [], promptsDisabled: false }
    }));
  }

  async completePending(eventIds: string[], nextAllowedAt: number): Promise<LocalState> {
    const completed = new Set(eventIds);
    return this.mutateState((state) => ({
        ...state,
        pendingEventIds: state.pendingEventIds.filter((id) => !completed.has(id)),
        rate: { ...state.rate, nextAllowedAt }
      }));
  }

  /** Atomically re-check and claim a surface-specific reminder slot across concurrent processes. */
  async claimPrompt(now = Date.now(), surface: "foreground" | "hook" = "foreground"): Promise<PromptDecision> {
    let decision: PromptDecision | null = null;
    await this.mutateState((state) => {
      decision = decidePrompt(state, now, surface);
      if (!decision.eligible) return state;
      const weekAgo = now - 7 * 24 * 60 * 60_000;
      const key = surface === "hook" ? "hookReminderShownAt" : "promptShownAt";
      return {
        ...state,
        rate: {
          ...state.rate,
          [key]: [...state.rate[key].filter((timestamp) => timestamp >= weekAgo), now].slice(-20)
        }
      };
    });
    if (decision === null) throw new Error("prompt decision unavailable");
    return decision;
  }

  /** Release an exact prompt reservation when its UI could not be presented. */
  async releasePromptClaim(claimedAt: number, surface: "foreground" | "hook" = "foreground"): Promise<LocalState> {
    return this.mutateState((state) => {
      const key = surface === "hook" ? "hookReminderShownAt" : "promptShownAt";
      const shownAt = state.rate[key];
      const index = shownAt.lastIndexOf(claimedAt);
      if (index === -1) return state;
      return {
        ...state,
        rate: {
          ...state.rate,
          [key]: [...shownAt.slice(0, index), ...shownAt.slice(index + 1)]
        }
      };
    });
  }

  async disablePrompts(): Promise<LocalState> {
    return this.mutateState((state) => ({ ...state, rate: { ...state.rate, promptsDisabled: true } }));
  }

  async registerAdapter(provider: Provider, mode: "installed" | "manual", now = Date.now()): Promise<LocalConfig> {
    return this.mutateConfig((config) => ({
      ...config,
      adapters: { ...config.adapters, [provider]: { mode, installedAt: now } }
    }));
  }

  async unregisterAdapter(provider: Provider): Promise<LocalConfig> {
    return this.mutateConfig((config) => {
      const adapters = { ...config.adapters };
      delete adapters[provider];
      return { ...config, adapters };
    });
  }
}

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};
