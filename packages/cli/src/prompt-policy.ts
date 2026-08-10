import type { LocalState, StoredEvent } from "./types.js";

export const MINIMUM_DAILY_EXPERIENCE_MS = 20 * 60_000;

export type PromptDecisionReason =
  | "eligible"
  | "disabled"
  | "cooldown"
  | "daily_cap"
  | "no_meaningful_experience";

export interface PromptDecision {
  eligible: boolean;
  reason: PromptDecisionReason;
  eventId: string | null;
}

export type PromptSurface = "foreground" | "hook";

const localDayKey = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const pendingSessionsToday = (state: LocalState, now: number): StoredEvent[][] => {
  const pending = new Set(state.pendingEventIds);
  const today = localDayKey(now);
  const sessions = new Map<string, StoredEvent[]>();
  for (const event of state.events) {
    if (!pending.has(event.id) || localDayKey(event.occurredAt) !== today) continue;
    const key = `${event.provider}:${event.sessionHash ?? event.id}`;
    sessions.set(key, [...(sessions.get(key) ?? []), event]);
  }
  return [...sessions.values()].map((events) => events.sort((left, right) => left.occurredAt - right.occurredAt)).sort((left, right) =>
    Math.max(...right.map(({ occurredAt }) => occurredAt)) - Math.max(...left.map(({ occurredAt }) => occurredAt))
  );
};

const experiencedMilliseconds = (sessions: StoredEvent[][]): number => sessions.reduce((total, events) => {
  if (events.length < 2) return total;
  return total + Math.max(0, events.at(-1)!.occurredAt - events[0]!.occurredAt);
}, 0);

/** Pure, outcome-independent cadence decision used by hooks and foreground prompts. */
export const decidePrompt = (state: LocalState, now = Date.now(), surface: PromptSurface = "foreground"): PromptDecision => {
  if (state.rate.promptsDisabled) return { eligible: false, reason: "disabled", eventId: null };
  if (state.rate.nextAllowedAt !== null && state.rate.nextAllowedAt > now) {
    return { eligible: false, reason: "cooldown", eventId: null };
  }
  const shownAt = surface === "hook"
    ? [...state.rate.promptShownAt, ...state.rate.hookReminderShownAt]
    : state.rate.promptShownAt;
  if (shownAt.some((timestamp) => localDayKey(timestamp) === localDayKey(now))) {
    return { eligible: false, reason: "daily_cap", eventId: null };
  }

  const sessions = pendingSessionsToday(state, now);
  const terminalEvent = sessions[0]?.at(-1) ?? null;
  if (!terminalEvent || experiencedMilliseconds(sessions) < MINIMUM_DAILY_EXPERIENCE_MS) {
    return { eligible: false, reason: "no_meaningful_experience", eventId: null };
  }
  return { eligible: true, reason: "eligible", eventId: terminalEvent.id };
};
