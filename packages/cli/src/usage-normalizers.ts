import { atPath, createEventId, firstTextAt, isRecord, normalizeModelIdentifier, sessionHash } from "./privacy.js";
import type { AttributionQuality, Provider, QuerySource, StoredQuotaSnapshot, StoredUsageSlice, UsageGranularity } from "./types.js";

type Path = readonly string[];

const SESSION_PATHS: readonly Path[] = [["session_id"], ["sessionId"], ["sessionID"], ["conversation_id"], ["conversationId"], ["properties", "sessionID"], ["params", "sessionId"]];
const REQUEST_PATHS: readonly Path[] = [["request_id"], ["requestId"], ["messageID"], ["message_id"], ["turn_id"], ["turnId"], ["properties", "info", "id"], ["id"]];
const MODEL_PATHS: readonly Path[] = [["reportedModel"], ["model"], ["model_id"], ["modelId"], ["modelID"], ["info", "modelID"], ["properties", "info", "modelID"], ["message", "model"]];
const EFFORT_PATHS: readonly Path[] = [["reasoningEffort"], ["reasoning_effort"], ["effort"], ["summary", "reasoningEffort"], ["attributes", "effort"], ["attributes", "reasoning_effort"]];
const VARIANT_PATHS: readonly Path[] = [["variant"], ["modelVariant"], ["info", "variant"], ["properties", "info", "variant"]];
const TIER_PATHS: readonly Path[] = [["service_tier"], ["serviceTier"], ["speed"], ["attributes", "speed"]];
const SOURCE_PATHS: readonly Path[] = [["query_source"], ["querySource"], ["attributes", "query_source"], ["source"]];

const USAGE_PATHS: readonly Path[] = [
  ["usage"], ["message", "usage"], ["info", "tokens"], ["properties", "info", "tokens"],
  ["tokens"], ["params", "update", "usage"], ["payload", "usage"]
];

const numberAt = (input: Record<string, unknown>, paths: readonly Path[]): number | null => {
  for (const path of paths) {
    const value = atPath(input, path);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000) return value;
  }
  return null;
};

const percentAt = (input: Record<string, unknown>, paths: readonly Path[]): number | null => {
  for (const path of paths) {
    const value = atPath(input, path);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  }
  return null;
};

const textAt = (input: Record<string, unknown>, paths: readonly Path[], maximum = 160): string | null => {
  const value = firstTextAt(input, paths);
  if (value === null || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
  return value;
};

const usageRecord = (payload: Record<string, unknown>): Record<string, unknown> | null => {
  for (const path of USAGE_PATHS) {
    const candidate = atPath(payload, path);
    if (isRecord(candidate)) return candidate;
  }
  return null;
};

type TokenCounts = Pick<StoredUsageSlice,
  "inputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "outputTokens" |
  "reasoningTokens" | "reportedTotalTokens"
>;

const tokenCounts = (usage: Record<string, unknown>): TokenCounts | null => {
  const inputTokens = numberAt(usage, [["input_tokens"], ["inputTokens"], ["input"]]) ?? 0;
  const cacheReadTokens = numberAt(usage, [["cached_input_tokens"], ["cache_read_input_tokens"], ["cache_read_tokens"], ["cacheReadTokens"], ["cachedReadTokens"], ["cache", "read"]]) ?? 0;
  const cacheWriteTokens = numberAt(usage, [["cache_creation_input_tokens"], ["cache_write_input_tokens"], ["cache_write_tokens"], ["cacheWriteTokens"], ["cacheCreationTokens"], ["cache", "write"]]) ?? 0;
  const outputTokens = numberAt(usage, [["output_tokens"], ["outputTokens"], ["output"]]) ?? 0;
  const reasoningTokens = numberAt(usage, [["reasoning_output_tokens"], ["reasoning_tokens"], ["reasoningTokens"], ["reasoning"]]) ?? 0;
  const reportedTotalTokens = numberAt(usage, [["total_tokens"], ["totalTokens"], ["total"]]);
  if (inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens + reasoningTokens <= 0) return null;
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, reportedTotalTokens };
};

const querySource = (value: string | null): QuerySource => {
  const normalized = value?.toLowerCase();
  return normalized === "main" || normalized === "subagent" || normalized === "auxiliary" || normalized === "background" ? normalized : "unknown";
};

const granularityFor = (provider: Provider, hasRequest: boolean): UsageGranularity => {
  if (provider === "claude") return "request";
  if (provider === "opencode") return "message";
  if (provider === "grok") return "session_model";
  if (provider === "codex") return hasRequest ? "turn" : "session_model";
  return hasRequest ? "turn" : "session_model";
};

const observedAt = (payload: Record<string, unknown>, now: number): number => {
  const numeric = numberAt(payload, [["observedAt"], ["timestamp_ms"], ["timestampMs"]]);
  if (numeric !== null && numeric > 1_000_000_000_000) return numeric;
  const text = firstTextAt(payload, [["timestamp"], ["occurred_at"], ["occurredAt"]]);
  const parsed = text === null ? Number.NaN : Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : now;
};

const oneSlice = (args: {
  payload: Record<string, unknown>;
  usage: Record<string, unknown>;
  provider: Provider;
  subscriptionId: string;
  hmacSecret: string;
  now: number;
  forcedModel?: string;
  granularity?: UsageGranularity;
  attributionQuality?: AttributionQuality;
}): StoredUsageSlice | null => {
  const counts = tokenCounts(args.usage);
  if (!counts) return null;
  const providerId = textAt(args.payload, [["providerID"], ["provider_id"], ["providerId"]], 80);
  const rawModel = args.forcedModel ?? textAt(args.payload, MODEL_PATHS);
  const normalizedModel = normalizeModelIdentifier(rawModel);
  const reportedModel = providerId && normalizedModel && !normalizedModel.includes("/")
    ? `${normalizeModelIdentifier(providerId) ?? providerId}/${normalizedModel}`
    : normalizedModel;
  if (!reportedModel) return null;
  const rawSession = firstTextAt(args.payload, SESSION_PATHS);
  const rawRequest = firstTextAt(args.payload, REQUEST_PATHS);
  const requestedModel = normalizeModelIdentifier(textAt(args.payload, [["requested_model"], ["requestedModel"]]));
  return {
    schemaVersion: 1,
    id: createEventId(),
    subscriptionId: args.subscriptionId,
    provider: args.provider,
    tool: args.provider === "claude" ? "claude-code" : args.provider === "grok" ? "grok-build" : args.provider,
    sessionHash: sessionHash(args.hmacSecret, rawSession),
    requestHash: sessionHash(args.hmacSecret, rawRequest === null ? null : `${rawRequest}:${args.forcedModel ?? ""}`),
    requestedModel,
    reportedModel,
    modelFamily: textAt(args.payload, [["model_family"], ["modelFamily"]], 80),
    modelVersion: textAt(args.payload, [["model_version"], ["modelVersion"]], 80),
    reasoningEffort: textAt(args.payload, EFFORT_PATHS, 32),
    modelVariant: textAt(args.payload, VARIANT_PATHS, 80),
    serviceTier: textAt(args.payload, TIER_PATHS, 40),
    querySource: querySource(textAt(args.payload, SOURCE_PATHS, 40)),
    granularity: args.granularity ?? granularityFor(args.provider, rawRequest !== null),
    attributionQuality: args.attributionQuality ?? "exact",
    tokenAttributionQuality: "exact",
    modelAttributionQuality: args.attributionQuality ?? "exact",
    effortAttributionQuality: textAt(args.payload, EFFORT_PATHS, 32) === null ? "unknown" : args.attributionQuality ?? "exact",
    ...counts,
    observedAt: observedAt(args.payload, args.now),
    recordedAt: args.now
  };
};

/**
 * Extract only documented counters and identifiers. Unknown payload fields are
 * ignored and can never be copied into local state.
 */
export const normalizeProviderUsage = (
  provider: Provider,
  payload: unknown,
  subscriptionId: string,
  hmacSecret: string,
  now = Date.now()
): StoredUsageSlice[] => {
  if (!isRecord(payload)) return [];
  // Grok exposes a session total split into modelUsage entries. Preserve that
  // split instead of assigning the session to the active model.
  const rawModelUsage = atPath(payload, ["params", "update", "usage", "modelUsage"])
    ?? atPath(payload, ["usage", "modelUsage"])
    ?? atPath(payload, ["modelUsage"]);
  if (isRecord(rawModelUsage)) {
    return Object.entries(rawModelUsage).flatMap(([model, value]) => {
      if (!isRecord(value)) return [];
      const slice = oneSlice({
        payload,
        usage: value,
        provider,
        subscriptionId,
        hmacSecret,
        now,
        forcedModel: model,
        granularity: "session_model",
        attributionQuality: "exact"
      });
      return slice ? [slice] : [];
    });
  }
  const direct = usageRecord(payload);
  if (!direct) return [];
  const slice = oneSlice({ payload, usage: direct, provider, subscriptionId, hmacSecret, now });
  return slice ? [slice] : [];
};

export const normalizeProviderQuota = (
  provider: Provider,
  payload: unknown,
  subscriptionId: string,
  now = Date.now()
): StoredQuotaSnapshot[] => {
  if (!isRecord(payload)) return [];
  const candidates: Array<{ scope: string; value: unknown }> = [];
  const rateLimits = atPath(payload, ["rateLimits"] ) ?? atPath(payload, ["rate_limits"]);
  if (isRecord(rateLimits)) {
    for (const [scope, value] of Object.entries(rateLimits)) candidates.push({ scope, value });
  }
  const direct = atPath(payload, ["quota"]);
  if (isRecord(direct)) candidates.push({ scope: textAt(direct, [["scope"]], 80) ?? "subscription", value: direct });
  return candidates.flatMap(({ scope, value }) => {
    if (!isRecord(value)) return [];
    const usedPercent = percentAt(value, [["used_percent"], ["usedPercent"]]);
    const remainingPercent = percentAt(value, [["remaining_percent"], ["remainingPercent"]]);
    if (usedPercent === null && remainingPercent === null) return [];
    const resetAtSeconds = numberAt(value, [["reset_at"], ["resets_at"], ["resetAt"], ["resetsAt"]]);
    const rawKind = textAt(value, [["window_kind"], ["windowKind"]], 20)?.toLowerCase();
    const windowKind = rawKind === "session" || rawKind === "daily" || rawKind === "weekly" || rawKind === "monthly" || rawKind === "rolling" ? rawKind : "unknown";
    return [{
      schemaVersion: 1,
      id: createEventId(),
      subscriptionId,
      provider,
      quotaScope: scope.slice(0, 80),
      windowKind,
      usedPercent,
      remainingPercent,
      resetAt: resetAtSeconds === null ? null : resetAtSeconds < 10_000_000_000 ? resetAtSeconds * 1_000 : resetAtSeconds,
      attributionQuality: "exact",
      observedAt: observedAt(payload, now),
      recordedAt: now
    } satisfies StoredQuotaSnapshot];
  });
};
