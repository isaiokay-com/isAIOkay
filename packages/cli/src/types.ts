export const PROVIDERS = [
  "codex",
  "claude",
  "cursor",
  "opencode",
  "gemini",
  "copilot",
  "cline",
  "windsurf",
  "aider",
  "amp",
  "grok",
  "qwen",
  "kimi",
  "muse"
] as const;

export type Provider = typeof PROVIDERS[number];

export type Attribution =
  | "active_model"
  | "session_start"
  | "explicit_model"
  | "opaque_auto"
  | "documented_model"
  | "before_model"
  | "session_end_unknown"
  | "task_complete"
  | "turn_model"
  | "agent_end"
  | "turn_complete"
  | "manual";

/**
 * This is the complete event shape allowed to reach local disk. It deliberately
 * has no prompt, response, transcript, path, repository, or raw session field.
 */
export interface StoredEvent {
  schemaVersion: 1;
  id: string;
  provider: Provider;
  attribution: Attribution;
  model: string | null;
  sessionHash: string | null;
  /** Optional local-only HMAC used to correlate a foreground wrapper with its parent shell. */
  shellHash?: string;
  occurredAt: number;
  recordedAt: number;
}

export type BillingPeriod = "monthly" | "annual" | "weekly" | "other";
export type AttributionQuality = "exact" | "inferred" | "estimated" | "unknown";
export type UsageGranularity = "request" | "message" | "turn" | "session_model";
export type QuerySource = "main" | "subagent" | "auxiliary" | "background" | "unknown";
export type QuotaWindowKind = "session" | "daily" | "weekly" | "monthly" | "rolling" | "unknown";

export interface LocalSubscription {
  id: string;
  provider: Provider;
  providerName: string;
  planLabel: string;
  planSlug?: string;
  billingPeriod: BillingPeriod;
  priceMicros: number | null;
  currency: string;
  aggregateConsent: boolean;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** Prompt-free token evidence queued locally until an authenticated sync. */
export interface StoredUsageSlice {
  schemaVersion: 1;
  id: string;
  subscriptionId: string;
  provider: Provider;
  tool: string;
  sessionHash: string | null;
  requestHash: string | null;
  requestedModel: string | null;
  reportedModel: string;
  modelFamily: string | null;
  modelVersion: string | null;
  reasoningEffort: string | null;
  modelVariant: string | null;
  serviceTier: string | null;
  querySource: QuerySource;
  granularity: UsageGranularity;
  attributionQuality: AttributionQuality;
  tokenAttributionQuality: AttributionQuality;
  modelAttributionQuality: AttributionQuality;
  effortAttributionQuality: AttributionQuality;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reportedTotalTokens: number | null;
  observedAt: number;
  recordedAt: number;
}

export interface StoredQuotaSnapshot {
  schemaVersion: 1;
  id: string;
  subscriptionId: string;
  provider: Provider;
  quotaScope: string;
  windowKind: QuotaWindowKind;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: number | null;
  attributionQuality: AttributionQuality;
  observedAt: number;
  recordedAt: number;
}

export type NormalizationResult =
  | {
      accepted: true;
      event: StoredEvent;
      /** True only when this exact host event has a user-only notification surface. */
      notificationSafe: boolean;
    }
  | { accepted: false; reason: NormalizationReason };

export type NormalizationReason =
  | "invalid_payload"
  | "unsupported_event"
  | "model_missing"
  | "unsafe_model_identifier";

export interface AdapterRegistration {
  mode: "installed" | "manual";
  installedAt: number;
}

export interface LocalConfig {
  schemaVersion: 1;
  hmacSecret: string;
  onboardingCompletedAt: number | null;
  adapters: Partial<Record<Provider, AdapterRegistration>>;
  subscriptions: LocalSubscription[];
  /** Default subscription for each harness. Multiple subscriptions may share a provider. */
  subscriptionBindings: Record<string, string>;
  shellIntegrations: Array<{
    shell: "bash" | "zsh" | "fish" | "powershell";
    path: string;
  }>;
}

export interface LocalState {
  schemaVersion: 1;
  events: StoredEvent[];
  pendingEventIds: string[];
  usage: StoredUsageSlice[];
  pendingUsageIds: string[];
  quota: StoredQuotaSnapshot[];
  pendingQuotaIds: string[];
  rate: {
    nextAllowedAt: number | null;
    hookReminderShownAt: number[];
    promptShownAt: number[];
    promptsDisabled: boolean;
  };
}

export interface StoragePaths {
  configFile: string;
  stateFile: string;
  credentialFile: string;
}

export interface CliCredential {
  schemaVersion: 1;
  serverUrl: string;
  accessToken: string;
  expiresAt: number;
}

export interface AdapterPlan {
  provider: Provider;
  /** How `install` will attach this tool: owned hook files, a documented manual bridge, or an explicit wrapper. */
  mode: "install" | "manual" | "bridge";
  configCandidates: string[];
  hookCommand: string;
  reason: string;
}

export interface ProviderAdapter {
  provider: Provider;
  mode: "install" | "manual" | "bridge";
  description: string;
  normalize: (payload: unknown, hmacSecret: string, now?: number) => NormalizationResult;
}

export interface DoctorResult {
  provider: Provider;
  mode: "install" | "manual" | "bridge";
  registered: boolean;
  candidateConfigFound: boolean;
  ownedIntegrationFound: boolean;
  message: string;
}

export interface ApiTrackedItem {
  id: string;
  slug: string;
  name: string;
  providerName: string;
  type: "model" | "agent";
}
