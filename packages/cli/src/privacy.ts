import { createHmac, randomUUID } from "node:crypto";
import type { Provider } from "./types.js";

export const MAX_INPUT_BYTES = 256 * 1024;
export const MAX_MODEL_IDENTIFIER_LENGTH = 120;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const getText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const atPath = (input: Record<string, unknown>, path: readonly string[]): unknown => {
  let current: unknown = input;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
};

export const firstTextAt = (input: Record<string, unknown>, paths: ReadonlyArray<readonly string[]>): string | null => {
  for (const path of paths) {
    const text = getText(atPath(input, path));
    if (text !== null) return text;
  }
  return null;
};

/** Only persist a conservative model identifier, never arbitrary provider text. */
export const normalizeModelIdentifier = (value: unknown): string | null => {
  const text = getText(value);
  if (text === null || text.length > MAX_MODEL_IDENTIFIER_LENGTH) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+\-#]*$/.test(text) ? text : null;
};

export const eventName = (input: Record<string, unknown>): string | null => {
  const value = firstTextAt(input, [
    ["event"],
    ["type"],
    ["hook_event_name"],
    ["hookEventName"],
    ["event_type"],
    ["event", "type"],
    ["data", "event"],
    ["payload", "event"]
  ]);
  return value === null ? null : value.toLowerCase().replace(/[\s._:-]/g, "");
};

export const sessionHash = (secret: string, rawSessionId: string | null): string | null => {
  if (rawSessionId === null) return null;
  return createHmac("sha256", secret).update(rawSessionId, "utf8").digest("base64url");
};

export const createEventId = (): string => randomUUID();

export const safeEventSummary = (provider: Provider, accepted: boolean, reason?: string): Record<string, unknown> =>
  accepted ? { accepted: true, provider } : { accepted: false, provider, reason: reason ?? "unsupported_event" };
