import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createTerminalForm, createTerminalSelect } from "../src/terminal.js";

class FakeInput extends EventEmitter {
  isRaw = false;
  readableFlowing: boolean | null;
  private paused: boolean;
  constructor(options: { paused?: boolean; readableFlowing?: boolean | null } = {}) {
    super();
    this.paused = options.paused ?? true;
    this.readableFlowing = options.readableFlowing ?? (this.paused ? false : null);
  }
  setRawMode(value: boolean): void { this.isRaw = value; }
  isPaused(): boolean { return this.paused; }
  pause(): this { this.paused = true; this.readableFlowing = false; return this; }
  resume(): this { this.paused = false; this.readableFlowing = true; return this; }
}

test("terminal menu pauses an initially non-flowing TTY after selection", async () => {
  // A real Node TTY starts with isPaused() false and readableFlowing null.
  // Resuming that stream without pausing it afterward keeps the CLI process alive.
  const input = new FakeInput({ paused: false, readableFlowing: null });
  const writer = { columns: 80, write: (): boolean => true };
  const select = createTerminalSelect(input as unknown as NodeJS.ReadStream, writer as unknown as NodeJS.WriteStream);
  const resultPromise = select("Continue setup?", [{ value: "yes", label: "Yes" }]);

  input.emit("keypress", "", { name: "return" });

  assert.equal(await resultPromise, "yes");
  assert.equal(input.isPaused(), true);
  assert.equal(input.readableFlowing, false);
});

test("terminal form supports arrow-key selection and restores terminal state", async () => {
  const input = new FakeInput();
  let output = "";
  const writer = { columns: 80, write: (chunk: string): boolean => { output += chunk; return true; } };
  const form = createTerminalForm(input as unknown as NodeJS.ReadStream, writer as unknown as NodeJS.WriteStream);
  const resultPromise = form("Rate this session", [
    { name: "quality", label: "Quality", initialValue: "3", choices: [
      { value: "2", label: "2 — Poor" }, { value: "3", label: "3 — Neutral" }, { value: "4", label: "4 — Good" }
    ] },
    { name: "speed", label: "Speed", initialValue: "3", choices: [
      { value: "2", label: "2 — Poor" }, { value: "3", label: "3 — Neutral" }, { value: "4", label: "4 — Good" }
    ] }
  ], { submitLabel: "continue" });

  input.emit("keypress", "", { name: "right" });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "left" });
  input.emit("keypress", "", { name: "return" });

  assert.deepEqual(await resultPromise, { quality: "4", speed: "2" });
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
  assert.match(output, /Rate this session/);
  assert.match(output, /←\/→ change/);
  assert.match(output, /\u001b\[\?25h/);
});

test("terminal form supports direct 1–5 rating hotkeys", async () => {
  const input = new FakeInput();
  let output = "";
  const writer = { columns: 80, write: (chunk: string): boolean => { output += chunk; return true; } };
  const form = createTerminalForm(input as unknown as NodeJS.ReadStream, writer as unknown as NodeJS.WriteStream);
  const choices = ["5", "4", "3", "2", "1"].map((value) => ({ value, label: value }));
  const resultPromise = form("Rate this session", [
    { name: "quality", label: "Quality", initialValue: "3", choices },
    { name: "speed", label: "Speed", initialValue: "3", choices }
  ]);

  input.emit("keypress", "5", { name: "5" });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "1", { name: "1" });
  input.emit("keypress", "", { name: "return" });

  assert.deepEqual(await resultPromise, { quality: "5", speed: "1" });
  assert.match(output, /1–5 rate/);
});
