import type { LocalState, StoredEvent } from "./types.js";

export const MINIMUM_DAILY_EXPERIENCE_MS = 20 * 60_000;
export const SAME_SHELL_SUGGESTION_MAX_AGE_MS = 30 * 60_000;

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

export interface ReminderStatus extends PromptDecision {
  experiencedMs: number;
  rateableExperiencedMs: number;
  pendingSessionCountToday: number;
  requiredExperienceMs: number;
  remainingExperienceMs: number;
  nextAllowedAt: number | null;
  lastPromptAt: number | null;
}

export type PromptSurface = "foreground" | "hook";

const localDayKey = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

const groupedSessions = (events: readonly StoredEvent[]): StoredEvent[][] => {
  const sessions = new Map<string, StoredEvent[]>();
  for (const event of events) {
    const key = `${event.provider}:${event.sessionHash ?? event.id}`;
    const session = sessions.get(key);
    if (session) session.push(event);
    else sessions.set(key, [event]);
  }
  return [...sessions.values()]
    .map((session) => session.sort((left, right) => left.occurredAt - right.occurredAt))
    .sort((left, right) => right.at(-1)!.occurredAt - left.at(-1)!.occurredAt);
};

const pendingEvents = (state: LocalState): StoredEvent[] => {
  const pending = new Set(state.pendingEventIds);
  return state.events.filter((event) => pending.has(event.id));
};

const pendingSessionsToday = (state: LocalState, now: number): StoredEvent[][] => {
  const today = localDayKey(now);
  return groupedSessions(pendingEvents(state).filter((event) => localDayKey(event.occurredAt) === today));
};

const TERMINAL_ATTRIBUTIONS = new Set<StoredEvent["attribution"]>([
  "session_end_unknown",
  "task_complete",
  "agent_end",
  "turn_complete",
  "turn_model"
]);

const hasCompletionSignal = (events: StoredEvent[]): boolean =>
  events.some((event) => TERMINAL_ATTRIBUTIONS.has(event.attribution))
  // Older Codex hooks and foreground wrappers did not distinguish their start
  // and end events. Retain compatibility only when the same session has a pair.
  || (events.length >= 2 && events.some((event) => event.attribution === "active_model" || event.attribution === "manual"));

const completedSessionsToday = (state: LocalState, now: number): StoredEvent[][] =>
  pendingSessionsToday(state, now).filter((events) =>
    events.length >= 2 && hasCompletionSignal(events)
  );

/** Select observed activity for an explicit rating, never a lifecycle start by itself. */
export const selectRateableSession = (state: LocalState, eventId?: string, shellHash?: string, now = Date.now()): StoredEvent[] | null => {
  const sessions = groupedSessions(pendingEvents(state)).filter((events) =>
    events.some((event) => event.attribution !== "session_start")
  );
  if (eventId !== undefined) return sessions.find((events) => events.some((event) => event.id === eventId)) ?? null;
  if (shellHash !== undefined) return sessions.find((events) => {
    const latest = events.at(-1)?.recordedAt ?? 0;
    return events.some((event) => event.shellHash === shellHash)
      && latest <= now + 60_000
      && latest >= now - SAME_SHELL_SUGGESTION_MAX_AGE_MS;
  }) ?? null;
  return null;
};

export const recordedSessionCount = (state: LocalState): number => groupedSessions(state.events).length;

export const pendingSessionCount = (state: LocalState): number => groupedSessions(pendingEvents(state)).length;

const experiencedMilliseconds = (sessions: StoredEvent[][]): number => sessions.reduce((total, events) => {
  if (events.length < 2) return total;
  return total + Math.max(0, events.at(-1)!.occurredAt - events[0]!.occurredAt);
}, 0);

export const experiencedToday = (state: LocalState, now = Date.now()): number =>
  experiencedMilliseconds(groupedSessions(state.events.filter((event) => localDayKey(event.occurredAt) === localDayKey(now))));

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

  const sessions = completedSessionsToday(state, now);
  const terminalEvent = sessions[0]?.at(-1) ?? null;
  if (!terminalEvent || experiencedMilliseconds(sessions) < MINIMUM_DAILY_EXPERIENCE_MS) {
    return { eligible: false, reason: "no_meaningful_experience", eventId: null };
  }
  return { eligible: true, reason: "eligible", eventId: terminalEvent.id };
};

export const reminderStatus = (state: LocalState, now = Date.now()): ReminderStatus => {
  const decision = decidePrompt(state, now);
  const experiencedMs = experiencedToday(state, now);
  const rateableSessions = completedSessionsToday(state, now);
  const rateableExperiencedMs = experiencedMilliseconds(rateableSessions);
  return {
    ...decision,
    experiencedMs,
    rateableExperiencedMs,
    pendingSessionCountToday: rateableSessions.length,
    requiredExperienceMs: MINIMUM_DAILY_EXPERIENCE_MS,
    remainingExperienceMs: Math.max(0, MINIMUM_DAILY_EXPERIENCE_MS - rateableExperiencedMs),
    nextAllowedAt: state.rate.nextAllowedAt,
    lastPromptAt: state.rate.promptShownAt.at(-1) ?? null
  };
};
