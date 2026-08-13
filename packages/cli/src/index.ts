export { doctorAdapter, getAdapterPlan, installAdapter, providerAdapters, uninstallAdapter } from "./adapters.js";
export { runCli } from "./cli.js";
export {
  normalizeAmp,
  normalizeAider,
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
  normalizeProviderEvent,
  normalizeQwen,
  normalizeWindsurf
} from "./normalizers.js";
export { decidePrompt } from "./prompt-policy.js";
export { summarizeSession } from "./session-summary.js";
export { defaultHarnessCommand, detectShell, installShellIntegration, renderShellIntegration, shellIntegrationInstalled, shellIntegrationPath, uninstallShellIntegration } from "./shell-integration.js";
export { LocalStore, atomicWriteJson, resolveStoragePaths } from "./storage.js";
export type {
  AdapterPlan,
  Attribution,
  DoctorResult,
  LocalConfig,
  LocalState,
  NormalizationResult,
  Provider,
  ProviderAdapter,
  StoredEvent,
  StoragePaths
} from "./types.js";
