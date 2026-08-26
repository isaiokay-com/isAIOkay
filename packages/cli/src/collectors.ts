import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { isRecord } from "./privacy.js";
import { normalizeProviderQuota, normalizeProviderUsage } from "./usage-normalizers.js";
import type { LocalConfig, Provider, StoredQuotaSnapshot, StoredUsageSlice } from "./types.js";

const MAX_FILES_PER_PROVIDER = 1_000;
const LOOKBACK_MS = 366 * 24 * 60 * 60_000;

interface CollectionResult {
  usage: StoredUsageSlice[];
  quota: StoredQuotaSnapshot[];
  diagnostics: Array<{ provider: Provider; files: number; usage: number; quota: number; configured: boolean }>;
}

const recentFiles = async (
  root: string,
  matches: (name: string) => boolean,
  now: number
): Promise<string[]> => {
  const found: Array<{ path: string; modified: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && matches(entry.name)) {
        const metadata = await stat(path).catch(() => null);
        if (metadata && metadata.mtimeMs >= now - LOOKBACK_MS) found.push({ path, modified: metadata.mtimeMs });
      }
    }
  };
  await visit(root);
  return found.sort((left, right) => right.modified - left.modified).slice(0, MAX_FILES_PER_PROVIDER).map(({ path }) => path);
};

const readJsonLines = async (file: string, consume: (value: Record<string, unknown>) => void): Promise<void> => {
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line || line.length > 4 * 1024 * 1024) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (isRecord(value)) consume(value);
      } catch {
        // Provider state may contain a final partial line while a session is active.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
};

const binding = (config: LocalConfig, provider: Provider): string | null => config.subscriptionBindings[provider] ?? null;

const collectClaude = async (root: string, config: LocalConfig, now: number): Promise<{ files: number; usage: StoredUsageSlice[] }> => {
  const subscriptionId = binding(config, "claude");
  if (!subscriptionId) return { files: 0, usage: [] };
  const files = await recentFiles(root, (name) => name.endsWith(".jsonl"), now);
  const usage = new Map<string, StoredUsageSlice>();
  for (const file of files) {
    await readJsonLines(file, (entry) => {
      const message = isRecord(entry.message) ? entry.message : null;
      if (!message || message.role !== "assistant" || !isRecord(message.usage) || typeof message.model !== "string") return;
      const requestId = typeof entry.requestId === "string" ? entry.requestId : typeof message.id === "string" ? message.id : null;
      if (!requestId) return;
      const envelope = {
        sessionId: typeof entry.sessionId === "string" ? entry.sessionId : typeof entry.session_id === "string" ? entry.session_id : null,
        requestId,
        model: message.model,
        effort: typeof entry.effort === "string" ? entry.effort : null,
        serviceTier: typeof message.usage.service_tier === "string" ? message.usage.service_tier : null,
        speed: typeof message.usage.speed === "string" ? message.usage.speed : null,
        querySource: entry.isSidechain === true ? "subagent" : "main",
        timestamp: entry.timestamp,
        usage: message.usage
      };
      for (const slice of normalizeProviderUsage("claude", envelope, subscriptionId, config.hmacSecret, now)) {
        if (slice.requestHash) usage.set(slice.requestHash, slice);
      }
    });
  }
  return { files: files.length, usage: [...usage.values()] };
};

const collectCodex = async (root: string, config: LocalConfig, now: number): Promise<{ files: number; usage: StoredUsageSlice[]; quota: StoredQuotaSnapshot[] }> => {
  const subscriptionId = binding(config, "codex");
  if (!subscriptionId) return { files: 0, usage: [], quota: [] };
  const files = await recentFiles(root, (name) => name.endsWith(".jsonl"), now);
  const usage = new Map<string, StoredUsageSlice>();
  const quota = new Map<string, StoredQuotaSnapshot>();
  for (const file of files) {
    let sessionId: string | null = null;
    let model: string | null = null;
    let effort: string | null = null;
    let turnId: string | null = null;
    await readJsonLines(file, (entry) => {
      const payload = isRecord(entry.payload) ? entry.payload : null;
      if (!payload) return;
      if (entry.type === "session_meta" && typeof payload.id === "string") sessionId = payload.id;
      if (entry.type === "turn_context") {
        if (typeof payload.model === "string") model = payload.model;
        effort = typeof payload.effort === "string" ? payload.effort : null;
        turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
        return;
      }
      if (entry.type !== "event_msg" || payload.type !== "token_count") return;
      const info = isRecord(payload.info) ? payload.info : null;
      const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
      if (!last || !model) return;
      const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : new Date(now).toISOString();
      const requestId = turnId ?? timestamp;
      const envelope = { sessionId, requestId, model, reasoningEffort: effort, timestamp, usage: last };
      for (const slice of normalizeProviderUsage("codex", envelope, subscriptionId, config.hmacSecret, now)) {
        if (slice.requestHash) usage.set(slice.requestHash, slice);
      }
      if (isRecord(payload.rate_limits)) {
        const quotaEnvelope = { timestamp, rateLimits: payload.rate_limits };
        for (const snapshot of normalizeProviderQuota("codex", quotaEnvelope, subscriptionId, now)) {
          const key = `${snapshot.quotaScope}:${snapshot.resetAt ?? "none"}:${snapshot.observedAt}`;
          quota.set(key, snapshot);
        }
      }
    });
  }
  return { files: files.length, usage: [...usage.values()], quota: [...quota.values()] };
};

const collectGrok = async (root: string, config: LocalConfig, now: number): Promise<{ files: number; usage: StoredUsageSlice[] }> => {
  const subscriptionId = binding(config, "grok");
  if (!subscriptionId) return { files: 0, usage: [] };
  const files = await recentFiles(root, (name) => name === "updates.jsonl", now);
  const usage = new Map<string, StoredUsageSlice>();
  for (const file of files) {
    const effortByModel = new Map<string, Set<string>>();
    try {
      const history = file.replace(/updates\.jsonl$/, "chat_history.jsonl");
      await readJsonLines(history, (entry) => {
        if (typeof entry.model_id !== "string" || typeof entry.reasoning_effort !== "string") return;
        const efforts = effortByModel.get(entry.model_id) ?? new Set<string>();
        efforts.add(entry.reasoning_effort);
        effortByModel.set(entry.model_id, efforts);
      });
    } catch {
      // Older Grok sessions may not have per-message effort metadata.
    }
    await readJsonLines(file, (entry) => {
      const params = isRecord(entry.params) ? entry.params : null;
      const update = params && isRecord(params.update) ? params.update : null;
      const rawUsage = update && isRecord(update.usage) ? update.usage : null;
      const modelUsage = rawUsage && isRecord(rawUsage.modelUsage) ? rawUsage.modelUsage : null;
      if (!params || !update || !modelUsage) return;
      const metadata = isRecord(params._meta) ? params._meta : null;
      const requestId = typeof metadata?.eventId === "string" ? metadata.eventId : typeof update.prompt_id === "string" ? update.prompt_id : null;
      if (!requestId) return;
      for (const [model, modelCounts] of Object.entries(modelUsage)) {
        if (!isRecord(modelCounts)) continue;
        const efforts = effortByModel.get(model);
        const knownEffort = efforts?.size === 1 ? [...efforts][0] ?? null : null;
        const seconds = typeof entry.timestamp === "number" ? entry.timestamp : null;
        const envelope = {
          sessionId: typeof params.sessionId === "string" ? params.sessionId : null,
          requestId: `${requestId}:${model}`,
          model,
          reasoningEffort: knownEffort,
          timestampMs: seconds === null ? now : seconds < 10_000_000_000 ? seconds * 1_000 : seconds,
          querySource: "main",
          usage: modelCounts
        };
        for (const slice of normalizeProviderUsage("grok", envelope, subscriptionId, config.hmacSecret, now)) {
          if (slice.requestHash) usage.set(slice.requestHash, {
            ...slice,
            attributionQuality: "exact",
            tokenAttributionQuality: "exact",
            modelAttributionQuality: "exact",
            effortAttributionQuality: knownEffort ? "exact" : "unknown"
          });
        }
      }
    });
  }
  return { files: files.length, usage: [...usage.values()] };
};

export const collectLocalTelemetry = async (config: LocalConfig, home: string, now = Date.now()): Promise<CollectionResult> => {
  const [claude, codex, grok] = await Promise.all([
    collectClaude(join(home, ".claude", "projects"), config, now),
    collectCodex(join(home, ".codex", "sessions"), config, now),
    collectGrok(join(home, ".grok", "sessions"), config, now)
  ]);
  const subscriptions = new Map(config.subscriptions.map((subscription) => [subscription.id, subscription]));
  const withinSubscription = (subscriptionId: string, observedAt: number): boolean => {
    const subscription = subscriptions.get(subscriptionId);
    // Tests and legacy local configurations can bind before the full local
    // subscription object exists; production-created bindings always resolve.
    if (!subscription) return config.subscriptions.length === 0;
    return (subscription.startedAt === null || observedAt >= subscription.startedAt) &&
      (subscription.endedAt === null || observedAt <= subscription.endedAt);
  };
  const usage = [...claude.usage, ...codex.usage, ...grok.usage].filter((entry) => withinSubscription(entry.subscriptionId, entry.observedAt));
  const quota = codex.quota.filter((entry) => withinSubscription(entry.subscriptionId, entry.observedAt));
  const providerUsage = (provider: Provider) => usage.filter((entry) => entry.provider === provider).length;
  const providerQuota = (provider: Provider) => quota.filter((entry) => entry.provider === provider).length;
  return {
    usage,
    quota,
    diagnostics: [
      { provider: "claude", files: claude.files, usage: providerUsage("claude"), quota: providerQuota("claude"), configured: binding(config, "claude") !== null },
      { provider: "codex", files: codex.files, usage: providerUsage("codex"), quota: providerQuota("codex"), configured: binding(config, "codex") !== null },
      { provider: "grok", files: grok.files, usage: providerUsage("grok"), quota: providerQuota("grok"), configured: binding(config, "grok") !== null }
    ]
  };
};
