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
  occurredAt: number;
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
  shellIntegrations: Array<{
    shell: "bash" | "zsh" | "fish" | "powershell";
    path: string;
  }>;
}

export interface LocalState {
  schemaVersion: 1;
  events: StoredEvent[];
  pendingEventIds: string[];
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
