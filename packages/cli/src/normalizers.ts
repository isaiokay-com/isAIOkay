import { createEventId, eventName, firstTextAt, isRecord, normalizeModelIdentifier, sessionHash } from "./privacy.js";
import type { Attribution, NormalizationResult, Provider, StoredEvent } from "./types.js";

const SESSION_PATHS: ReadonlyArray<readonly string[]> = [
  ["session_id"],
  ["sessionId"],
  ["sessionID"],
  ["conversation_id"],
  ["conversationId"],
  ["data", "session_id"],
  ["data", "sessionId"],
  ["payload", "session_id"],
  ["payload", "sessionId"]
];

const MODEL_PATHS: ReadonlyArray<readonly string[]> = [
  ["model"],
  ["model_id"],
  ["modelId"],
  ["data", "model"],
  ["data", "model_id"],
  ["payload", "model"],
  ["payload", "model_id"],
  ["llm_request", "model"]
];

const occurredAt = (input: Record<string, unknown>, fallback: number): number => {
  const candidate = firstTextAt(input, [["timestamp"], ["occurred_at"], ["occurredAt"], ["data", "timestamp"]]);
  if (candidate === null) return fallback;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const makeEvent = (args: {
  provider: Provider;
  attribution: Attribution;
  model: string | null;
  rawSessionId: string | null;
  hmacSecret: string;
  input: Record<string, unknown>;
  now: number;
}): StoredEvent => ({
  schemaVersion: 1,
  id: createEventId(),
  provider: args.provider,
  attribution: args.attribution,
  model: args.model,
  sessionHash: sessionHash(args.hmacSecret, args.rawSessionId),
  occurredAt: occurredAt(args.input, args.now),
  recordedAt: args.now
});

const rawSession = (input: Record<string, unknown>): string | null => firstTextAt(input, SESSION_PATHS);

const rawModel = (input: Record<string, unknown>): string | null => firstTextAt(input, MODEL_PATHS);

const exactProviderModel = (provider: string | null, model: string | null): string | null => {
  const safeProvider = normalizeModelIdentifier(provider);
  const safeModel = normalizeModelIdentifier(model);
  return safeProvider !== null && safeModel !== null ? `${safeProvider}/${safeModel}` : null;
};

const invalid = (reason: Extract<NormalizationResult, { accepted: false }> ["reason"]): NormalizationResult => ({ accepted: false, reason });

/** Codex common lifecycle hook payloads include the active model. */
export const normalizeCodex = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker !== "modelactive" && marker !== "modelchanged" && marker !== "sessionstart" && marker !== "stop" && marker !== "sessionend") return invalid("unsupported_event");
  const candidate = rawModel(payload);
  if (candidate === null) return invalid("model_missing");
  const model = normalizeModelIdentifier(candidate);
  if (model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: marker === "stop",
    event: makeEvent({
      provider: "codex",
      attribution: marker === "sessionstart" ? "session_start" : marker === "stop" || marker === "sessionend" ? "turn_complete" : "active_model",
      model,
      rawSessionId: rawSession(payload),
      hmacSecret,
      input: payload,
      now
    })
  };
};

/** Claude captures its start model and later terminal signals without reading transcript/cwd. */
export const normalizeClaude = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker === "stop" || marker === "sessionend") {
    return {
      accepted: true,
      notificationSafe: marker === "stop",
      event: makeEvent({ provider: "claude", attribution: "session_end_unknown", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
    };
  }
  if (marker !== "sessionstart") return invalid("unsupported_event");
  const candidate = rawModel(payload);
  const model = candidate === null ? null : normalizeModelIdentifier(candidate);
  if (candidate !== null && model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "claude", attribution: "session_start", model, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
  };
};

/**
 * Cursor's automatic selection is deliberately opaque. A model is only named
 * when the producer sends an explicit, safe model identifier in the envelope.
 */
export const normalizeCursor = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  const streamInit = marker === "system" && firstTextAt(payload, [["subtype"]])?.toLowerCase() === "init";
  if (marker !== "modelselected" && marker !== "sessionstart" && marker !== "stop" && !streamInit) return invalid("unsupported_event");
  const candidate = rawModel(payload);
  if (candidate !== null && candidate.toLowerCase() === "auto") {
    return {
      accepted: true,
      notificationSafe: false,
      event: makeEvent({ provider: "cursor", attribution: "opaque_auto", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
    };
  }
  if (candidate === null) return invalid("model_missing");
  const model = normalizeModelIdentifier(candidate);
  if (model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({
      provider: "cursor",
      attribution: marker === "stop" ? "turn_complete" : "explicit_model",
      model,
      rawSessionId: rawSession(payload),
      hmacSecret,
      input: payload,
      now
    })
  };
};

/**
 * OpenCode's plugin API is evolving. This accepts only the package's explicit
 * safe bridge envelope (`event: isaiokay.opencode.model`) rather than trying
 * to parse request hooks, which can contain prompts and messages.
 */
export const normalizeOpenCode = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker !== "messageupdated" && marker !== "sessionidle" && marker !== "isaiokayopencodemodel") return invalid("unsupported_event");
  if (marker === "messageupdated") {
    const role = firstTextAt(payload, [
      ["role"],
      ["message", "role"],
      ["info", "role"],
      ["properties", "info", "role"],
      ["payload", "role"],
      ["payload", "message", "role"],
      ["payload", "info", "role"]
    ]);
    if (role?.toLowerCase() !== "assistant") return invalid("unsupported_event");
  }
  const providerId = firstTextAt(payload, [
    ["providerID"], ["provider_id"], ["providerId"], ["message", "providerID"], ["info", "providerID"],
    ["properties", "info", "providerID"], ["payload", "providerID"], ["payload", "info", "providerID"]
  ]);
  const modelId = firstTextAt(payload, [
    ["modelID"], ["model_id"], ["modelId"], ["message", "modelID"], ["info", "modelID"],
    ["properties", "info", "modelID"], ["payload", "modelID"], ["payload", "info", "modelID"]
  ]);
  const model = exactProviderModel(providerId, modelId) ?? normalizeModelIdentifier(rawModel(payload));
  if (model === null && marker !== "sessionidle") return providerId === null && modelId === null && rawModel(payload) === null ? invalid("model_missing") : invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: marker === "sessionidle",
    event: makeEvent({
      provider: "opencode",
      attribution: model === null ? "turn_complete" : "documented_model",
      model,
      rawSessionId: rawSession(payload) ?? firstTextAt(payload, [["properties", "sessionID"], ["payload", "sessionID"]]),
      hmacSecret,
      input: payload,
      now
    })
  };
};

/** Gemini CLI BeforeModel exposes only the configured model and session identifier. */
export const normalizeGemini = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker === "sessionend") {
    return {
      accepted: true,
      notificationSafe: false,
      event: makeEvent({ provider: "gemini", attribution: "session_end_unknown", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
    };
  }
  if (marker === "afteragent") {
    return {
      accepted: true,
      notificationSafe: true,
      event: makeEvent({ provider: "gemini", attribution: "turn_complete", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
    };
  }
  if (marker !== "beforemodel") return invalid("unsupported_event");
  const model = normalizeModelIdentifier(firstTextAt(payload, [["llm_request", "model"], ["data", "llm_request", "model"]]));
  if (model === null) return rawModel(payload) === null ? invalid("model_missing") : invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "gemini", attribution: "before_model", model, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
  };
};

/** Copilot's sessionEnd signal has a session but no trustworthy model attribution. */
export const normalizeCopilot = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker !== "sessionend" && marker !== "agentstop") return invalid("unsupported_event");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "copilot", attribution: marker === "agentstop" ? "turn_complete" : "session_end_unknown", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
  };
};

/** Cline task terminal events include an exact provider/model slug pair. */
export const normalizeCline = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker !== "taskcomplete" && marker !== "taskcancel") return invalid("unsupported_event");
  const providerId = firstTextAt(payload, [["provider"], ["model_provider"], ["modelProvider"], ["payload", "provider"]]);
  const slug = firstTextAt(payload, [["slug"], ["model_slug"], ["modelSlug"], ["payload", "slug"]]);
  const model = exactProviderModel(providerId, slug);
  if (model === null) return providerId === null && slug === null ? invalid("model_missing") : invalid("unsafe_model_identifier");
  const taskId = firstTextAt(payload, [["taskId"], ["task_id"], ["payload", "taskId"]]);
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "cline", attribution: "task_complete", model, rawSessionId: taskId, hmacSecret, input: payload, now })
  };
};

/** Windsurf reports a per-turn model; trajectory IDs are hashed as session identifiers. */
export const normalizeWindsurf = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  if (eventName(payload) !== "postcascaderesponse") return invalid("unsupported_event");
  const candidate = firstTextAt(payload, [["model_name"], ["modelName"], ["payload", "model_name"]]);
  if (candidate === null) return invalid("model_missing");
  const model = normalizeModelIdentifier(candidate);
  if (model === null) return invalid("unsafe_model_identifier");
  const trajectoryId = firstTextAt(payload, [["trajectory_id"], ["trajectoryId"], ["payload", "trajectory_id"]]);
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "windsurf", attribution: "turn_model", model, rawSessionId: trajectoryId, hmacSecret, input: payload, now })
  };
};

/** Aider has no native hook installer here; accept only its explicit wrapper envelope. */
export const normalizeAider = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  if (eventName(payload) !== "isaiokayaidermodel") return invalid("unsupported_event");
  const candidate = rawModel(payload);
  if (candidate === null) return invalid("model_missing");
  const model = normalizeModelIdentifier(candidate);
  if (model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "aider", attribution: "manual", model, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
  };
};

/** Amp's agent.end is a per-turn signal; retain a model only when explicitly supplied. */
export const normalizeAmp = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  if (eventName(payload) !== "agentend") return invalid("unsupported_event");
  const candidate = rawModel(payload);
  const model = candidate === null ? null : normalizeModelIdentifier(candidate);
  if (candidate !== null && model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: true,
    event: makeEvent({
      provider: "amp",
      attribution: "agent_end",
      model,
      rawSessionId: rawSession(payload) ?? firstTextAt(payload, [["thread_id"], ["threadId"], ["thread", "id"]]),
      hmacSecret,
      input: payload,
      now
    })
  };
};

/** Grok Build emits camelCase lifecycle names; only genuine turn completion is retained. */
export const normalizeGrok = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker === "stop") {
    const reason = firstTextAt(payload, [["reason"]]);
    if (reason !== "end_turn") return invalid("unsupported_event");
    return {
      accepted: true,
      notificationSafe: false,
      event: makeEvent({ provider: "grok", attribution: "turn_complete", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
    };
  }
  if (marker !== "sessionstart") return invalid("unsupported_event");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "grok", attribution: "session_start", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
  };
};

/** Qwen Code documents the exact active model on SessionStart. */
export const normalizeQwen = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker === "stop" || marker === "sessionend") {
    return {
      accepted: true,
      notificationSafe: false,
      event: makeEvent({ provider: "qwen", attribution: marker === "stop" ? "turn_complete" : "session_end_unknown", model: null, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
    };
  }
  if (marker !== "sessionstart") return invalid("unsupported_event");
  const candidate = rawModel(payload);
  const model = candidate === null ? null : normalizeModelIdentifier(candidate);
  if (candidate !== null && model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "qwen", attribution: "session_start", model, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
  };
};

/** Kimi Code documents the configured model on SessionStart. */
export const normalizeKimi = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  const marker = eventName(payload);
  if (marker !== "sessionstart" && marker !== "stop" && marker !== "sessionend") return invalid("unsupported_event");
  const candidate = marker === "sessionstart" ? rawModel(payload) : null;
  const model = candidate === null ? null : normalizeModelIdentifier(candidate);
  if (candidate !== null && model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({
      provider: "kimi",
      attribution: marker === "sessionstart" ? "session_start" : marker === "stop" ? "turn_complete" : "session_end_unknown",
      model,
      rawSessionId: rawSession(payload),
      hmacSecret,
      input: payload,
      now
    })
  };
};

/** Muse currently uses the foreground wrapper; accept only an explicit safe bridge envelope. */
export const normalizeMuse = (payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  if (!isRecord(payload)) return invalid("invalid_payload");
  if (eventName(payload) !== "isaiokaymusemodel") return invalid("unsupported_event");
  const candidate = rawModel(payload);
  const model = candidate === null ? null : normalizeModelIdentifier(candidate);
  if (candidate !== null && model === null) return invalid("unsafe_model_identifier");
  return {
    accepted: true,
    notificationSafe: false,
    event: makeEvent({ provider: "muse", attribution: "manual", model, rawSessionId: rawSession(payload), hmacSecret, input: payload, now })
  };
};

export const normalizeProviderEvent = (provider: Provider, payload: unknown, hmacSecret: string, now = Date.now()): NormalizationResult => {
  switch (provider) {
    case "codex": return normalizeCodex(payload, hmacSecret, now);
    case "claude": return normalizeClaude(payload, hmacSecret, now);
    case "cursor": return normalizeCursor(payload, hmacSecret, now);
    case "opencode": return normalizeOpenCode(payload, hmacSecret, now);
    case "gemini": return normalizeGemini(payload, hmacSecret, now);
    case "copilot": return normalizeCopilot(payload, hmacSecret, now);
    case "cline": return normalizeCline(payload, hmacSecret, now);
    case "windsurf": return normalizeWindsurf(payload, hmacSecret, now);
    case "aider": return normalizeAider(payload, hmacSecret, now);
    case "amp": return normalizeAmp(payload, hmacSecret, now);
    case "grok": return normalizeGrok(payload, hmacSecret, now);
    case "qwen": return normalizeQwen(payload, hmacSecret, now);
    case "kimi": return normalizeKimi(payload, hmacSecret, now);
    case "muse": return normalizeMuse(payload, hmacSecret, now);
  }
};
