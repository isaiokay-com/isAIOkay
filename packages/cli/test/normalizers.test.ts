import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeAider,
  normalizeAmp,
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
  normalizeQwen,
  normalizeWindsurf
} from "../src/normalizers.js";

const secret = "test-secret-that-is-only-used-for-hmac-unit-tests";
const now = 1_700_000_000_000;

const accepted = <T extends { accepted: boolean }>(result: T): Extract<T, { accepted: true }> => {
  assert.equal(result.accepted, true);
  return result as Extract<T, { accepted: true }>;
};

test("Codex records only an explicit active model and HMACs its session", () => {
  const rawSession = "codex-private-session";
  const event = accepted(normalizeCodex({ event: "model.active", model: "gpt-5.6-codex", session_id: rawSession, prompt: "do not store me" }, secret, now)).event;
  assert.equal(event.provider, "codex");
  assert.equal(event.attribution, "active_model");
  assert.equal(event.model, "gpt-5.6-codex");
  assert.notEqual(event.sessionHash, rawSession);
  assert.equal(JSON.stringify(event).includes("do not store me"), false);
  const stop = accepted(normalizeCodex({ hook_event_name: "Stop", model: "gpt-5.6-codex", session_id: rawSession }, secret, now));
  assert.equal(stop.event.attribution, "turn_complete");
  assert.equal(stop.notificationSafe, true);
  const start = accepted(normalizeCodex({ hook_event_name: "SessionStart", model: "gpt-5.6-codex", session_id: rawSession }, secret, now));
  assert.equal(start.event.attribution, "session_start");
});

test("Claude correlates SessionStart and terminal events without consuming transcript/cwd fields", () => {
  const event = accepted(normalizeClaude({
    hook_event_name: "SessionStart",
    session_id: "claude-private-session",
    model: "claude-sonnet-5",
    transcript_path: "/very/private/transcript.jsonl",
    cwd: "/private/repository",
    prompt: "private prompt"
  }, secret, now)).event;
  assert.equal(event.attribution, "session_start");
  assert.equal(event.model, "claude-sonnet-5");
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("transcript"), false);
  assert.equal(serialized.includes("repository"), false);
  const end = accepted(normalizeClaude({ hook_event_name: "SessionEnd", session_id: "claude-private-session", transcript_path: "/private/transcript" }, secret, now)).event;
  assert.equal(end.attribution, "session_end_unknown");
  assert.equal(end.model, null);
  assert.equal(normalizeClaude({ hook_event_name: "PostToolUse" }, secret, now).accepted, false);
});

test("Cursor labels Auto as opaque and preserves only explicit safe identifiers", () => {
  const auto = accepted(normalizeCursor({ event: "model.selected", model: "Auto", sessionId: "cursor-session" }, secret, now)).event;
  assert.equal(auto.attribution, "opaque_auto");
  assert.equal(auto.model, null);

  const explicit = accepted(normalizeCursor({ event: "model.selected", model: "claude-4.5-sonnet", sessionId: "cursor-session" }, secret, now)).event;
  assert.equal(explicit.attribution, "explicit_model");
  assert.equal(explicit.model, "claude-4.5-sonnet");
  const stream = accepted(normalizeCursor({ type: "system", subtype: "init", model: "gpt-5", session_id: "cursor-session" }, secret, now)).event;
  assert.equal(stream.model, "gpt-5");
  const stop = accepted(normalizeCursor({ hook_event_name: "stop", model: "composer-2", conversation_id: "cursor-session", status: "completed" }, secret, now));
  assert.equal(stop.event.attribution, "turn_complete");
  assert.equal(stop.notificationSafe, false);
});

test("OpenCode reads only assistant model identifiers from documented-safe fields", () => {
  const event = accepted(normalizeOpenCode({
    event: "message.updated",
    properties: { sessionID: "opencode-private-session", info: { role: "assistant", providerID: "openai", modelID: "gpt-5.6" } },
    messages: [{ role: "user", content: "private prompt" }]
  }, secret, now)).event;
  assert.equal(event.model, "openai/gpt-5.6");
  assert.equal(event.attribution, "documented_model");
  assert.equal(JSON.stringify(event).includes("private prompt"), false);
  const idle = accepted(normalizeOpenCode({ event: "session.idle", sessionID: "opencode-private-session" }, secret, now));
  assert.equal(idle.event.model, null);
  assert.equal(idle.event.attribution, "turn_complete");
  assert.equal(idle.notificationSafe, true);
  assert.equal(normalizeOpenCode({ event: "message.updated", message: { role: "user", providerID: "openai", modelID: "gpt-5.6" } }, secret, now).accepted, false);
});

test("Gemini and Copilot reflect their different attribution guarantees", () => {
  const gemini = accepted(normalizeGemini({ event: "BeforeModel", llm_request: { model: "gemini-2.5-pro" }, session_id: "gemini-session" }, secret, now)).event;
  assert.equal(gemini.attribution, "before_model");
  assert.equal(gemini.model, "gemini-2.5-pro");

  const sessionEnd = accepted(normalizeGemini({ event: "SessionEnd", session_id: "gemini-session" }, secret, now)).event;
  assert.equal(sessionEnd.attribution, "session_end_unknown");
  assert.equal(sessionEnd.model, null);

  const afterAgent = accepted(normalizeGemini({ hook_event_name: "AfterAgent", session_id: "gemini-session", prompt: "private", prompt_response: "private" }, secret, now));
  assert.equal(afterAgent.event.attribution, "turn_complete");
  assert.equal(afterAgent.notificationSafe, true);
  assert.equal(JSON.stringify(afterAgent.event).includes("private"), false);

  const copilot = accepted(normalizeCopilot({ event: "sessionEnd", sessionId: "copilot-session", model: "untrusted-guess" }, secret, now)).event;
  assert.equal(copilot.attribution, "session_end_unknown");
  assert.equal(copilot.model, null);
  const agentStop = accepted(normalizeCopilot({ event: "agentStop", sessionId: "copilot-session", transcriptPath: "/private" }, secret, now));
  assert.equal(agentStop.event.attribution, "turn_complete");
  assert.equal(agentStop.notificationSafe, false);
});

test("Cline, Windsurf, and Aider use explicit safe bridge inputs", () => {
  const cline = accepted(normalizeCline({ event: "TaskComplete", taskId: "cline-task", provider: "anthropic", slug: "claude-sonnet-4-5" }, secret, now)).event;
  assert.equal(cline.model, "anthropic/claude-sonnet-4-5");
  assert.equal(cline.attribution, "task_complete");

  const windsurf = accepted(normalizeWindsurf({ event: "post_cascade_response", trajectory_id: "windsurf-trajectory", model_name: "windsurf-swe-1" }, secret, now)).event;
  assert.equal(windsurf.model, "windsurf-swe-1");
  assert.equal(windsurf.attribution, "turn_model");

  const aider = accepted(normalizeAider({ event: "isaiokay.aider.model", session_id: "aider-session", model: "openai/gpt-5.6" }, secret, now)).event;
  assert.equal(aider.attribution, "manual");
  assert.equal(aider.model, "openai/gpt-5.6");
});

test("Amp records agent.end without guessing a missing model", () => {
  const unknown = accepted(normalizeAmp({ event: "agent.end", thread: { id: "private-thread" } }, secret, now)).event;
  assert.equal(unknown.provider, "amp");
  assert.equal(unknown.attribution, "agent_end");
  assert.equal(unknown.model, null);
  assert.notEqual(unknown.sessionHash, "private-thread");

  const explicit = accepted(normalizeAmp({ event: "agent.end", thread_id: "private-thread", model: "anthropic/claude-opus-4-1" }, secret, now)).event;
  assert.equal(explicit.model, "anthropic/claude-opus-4-1");
});

test("Grok records genuine completed turns and Muse accepts only its explicit wrapper envelope", () => {
  const start = accepted(normalizeGrok({ hookEventName: "SessionStart", sessionId: "grok-session" }, secret, now));
  assert.equal(start.event.attribution, "session_start");
  const stop = accepted(normalizeGrok({ hookEventName: "Stop", sessionId: "grok-session", reason: "end_turn", transcript: "private" }, secret, now));
  assert.equal(stop.event.attribution, "turn_complete");
  assert.equal(stop.notificationSafe, false);
  assert.equal(JSON.stringify(stop.event).includes("private"), false);
  assert.equal(normalizeGrok({ hookEventName: "Stop", sessionId: "grok-session" }, secret, now).accepted, false);
  assert.equal(normalizeGrok({ hookEventName: "Stop", sessionId: "grok-session", reason: "shutdown" }, secret, now).accepted, false);

  const muse = accepted(normalizeMuse({ event: "isaiokay.muse.model", session_id: "muse-session", model: "muse-spark-1.2" }, secret, now)).event;
  assert.equal(muse.provider, "muse");
  assert.equal(muse.model, "muse-spark-1.2");
});

test("Qwen and Kimi record only their documented start-model fields", () => {
  const qwenStart = accepted(normalizeQwen({
    hook_event_name: "SessionStart",
    session_id: "private-qwen-session",
    model: "qwen3.8-max",
    cwd: "/private/workspace",
    prompt: "private"
  }, secret, now)).event;
  assert.equal(qwenStart.provider, "qwen");
  assert.equal(qwenStart.attribution, "session_start");
  assert.equal(qwenStart.model, "qwen3.8-max");
  assert.equal(JSON.stringify(qwenStart).includes("private/workspace"), false);
  const qwenStop = accepted(normalizeQwen({ hook_event_name: "Stop", session_id: "private-qwen-session" }, secret, now));
  assert.equal(qwenStop.event.attribution, "turn_complete");
  assert.equal(qwenStop.event.model, null);
  assert.equal(qwenStop.notificationSafe, false);

  const kimiStart = accepted(normalizeKimi({ hook_event_name: "SessionStart", session_id: "private-kimi-session", model: "k3", profile: "kimi-code" }, secret, now)).event;
  assert.equal(kimiStart.provider, "kimi");
  assert.equal(kimiStart.attribution, "session_start");
  assert.equal(kimiStart.model, "k3");
  assert.equal(accepted(normalizeKimi({ hook_event_name: "SessionStart", session_id: "private-kimi-session", model: "kimi-for-coding-highspeed" }, secret, now)).event.model, "kimi-for-coding-highspeed");
  const kimiStop = accepted(normalizeKimi({ hook_event_name: "Stop", session_id: "private-kimi-session", stop_hook_active: false }, secret, now)).event;
  assert.equal(kimiStop.attribution, "turn_complete");
  assert.equal(normalizeKimi({ hook_event_name: "PreToolUse" }, secret, now).accepted, false);
});

test("unsafe model labels and raw session identifiers never become a stored event", () => {
  const unsafe = normalizeCodex({ event: "model.active", model: "prompt text with spaces", session_id: "raw-session" }, secret, now);
  assert.deepEqual(unsafe, { accepted: false, reason: "unsafe_model_identifier" });
  const first = accepted(normalizeCodex({ event: "model.active", model: "gpt-5", session_id: "same-session" }, secret, now)).event;
  const second = accepted(normalizeCodex({ event: "model.active", model: "gpt-5", session_id: "same-session" }, "other-secret", now)).event;
  assert.notEqual(first.sessionHash, second.sessionHash);
});
