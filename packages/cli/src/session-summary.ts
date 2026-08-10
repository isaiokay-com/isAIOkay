import type { Provider, StoredEvent } from "./types.js";

export interface SessionSummary {
  orderedEvents: StoredEvent[];
  model: string | null;
  mixed: boolean;
  attributionEvent: StoredEvent;
}

/** Resolve the final observable state without carrying an earlier Cursor model through Auto. */
export const summarizeSession = (events: StoredEvent[], provider: Provider): SessionSummary => {
  if (events.length === 0) throw new Error("session summary requires at least one event");
  const orderedEvents = [...events].sort((left, right) => left.occurredAt - right.occurredAt || left.recordedAt - right.recordedAt);
  const models = [...new Set(orderedEvents.flatMap((event) => event.model ? [event.model] : []))];
  const mixed = models.length > 1;
  const lastModelIndex = orderedEvents.findLastIndex((event) => event.model !== null);
  const lastOpaqueIndex = orderedEvents.findLastIndex((event) => event.attribution === "opaque_auto");
  const opaqueActive = provider === "cursor" && lastOpaqueIndex > lastModelIndex;
  const attributionEvent = opaqueActive
    ? orderedEvents[lastOpaqueIndex]!
    : [...orderedEvents].reverse().find((event) => event.model !== null) ?? orderedEvents.at(-1)!;
  return {
    orderedEvents,
    model: mixed || opaqueActive ? null : models[0] ?? orderedEvents.at(-1)!.model,
    mixed,
    attributionEvent
  };
};
