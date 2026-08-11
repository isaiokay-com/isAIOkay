#!/usr/bin/env node
import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:os";
import { createInterface } from "node:readline/promises";
import crossSpawn from "cross-spawn";
import { browserLaunchCommand, detectBrowserAvailability } from "../browser.js";
import { runCli } from "../cli.js";
import { executableExists } from "../executable.js";
import { createTerminalForm, createTerminalMultiSelect, createTerminalSelect } from "../terminal.js";

let readline: ReturnType<typeof createInterface> | undefined;

const openUrl = async (url: string): Promise<void> => {
  const { command, args } = browserLaunchCommand(process.platform, url);
  await new Promise<void>((resolve, reject) => {
    const child = nodeSpawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.once("error", (error) => { finish(error); });
    child.once("spawn", () => {
      // Give launchers a short window to report an immediate failure. Some
      // browser processes stay attached, so login must not wait for exit.
      timer = setTimeout(() => {
        child.unref();
        finish();
      }, 750);
    });
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`Browser launcher exited with status ${code ?? "unknown"}.`));
    });
  });
};

const runCommand = async (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number; wrapperShuttingDown: boolean }> => new Promise((resolve, reject) => {
  // cross-spawn preserves direct argv semantics on Unix while safely resolving
  // Windows npm shims and .cmd/.bat launchers without shell:true.
  const child = crossSpawn(command, args, { env, stdio: "inherit", windowsHide: false });
  const handledSignals: NodeJS.Signals[] = process.platform === "win32"
    ? ["SIGINT", "SIGBREAK", "SIGTERM", "SIGHUP"]
    : ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"];
  const terminalGroupSignals = new Set<NodeJS.Signals>(["SIGINT", "SIGQUIT", "SIGBREAK"]);
  const listeners = new Map<NodeJS.Signals, () => void>();
  let wrapperShuttingDown = false;
  let settled = false;
  const cleanup = (): void => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  };
  const finish = (error: Error | null, exitCode = 1): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) reject(error);
    else resolve({ exitCode, wrapperShuttingDown });
  };
  for (const signal of handledSignals) {
    const listener = (): void => {
      if (signal === "SIGHUP" || signal === "SIGTERM") wrapperShuttingDown = true;
      // Interactive control signals are delivered by the terminal directly to
      // every process in its foreground group. Forwarding them again can turn
      // one Ctrl-C into two interrupts. Shutdown signals may target only this
      // wrapper, so those still need to be relayed to the child.
      if (!terminalGroupSignals.has(signal) && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill(signal);
        } catch {
          // The terminal already delivered the signal or this OS does not
          // support forwarding it. The child close event remains authoritative.
        }
      }
    };
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  child.once("error", (error) => { finish(error); });
  child.once("close", (code, signal) => {
    const signalCode = signal ? constants.signals[signal] ?? 1 : 0;
    finish(null, code ?? 128 + signalCode);
  });
});

const interactive = process.stdin.isTTY && process.stdout.isTTY;

process.exitCode = await runCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  platform: process.platform,
  fetch,
  openUrl,
  browserAvailable: detectBrowserAvailability(process.platform, process.env),
  commandExists: (command) => executableExists(command, { env: process.env, platform: process.platform }),
  runCommand,
  ...(interactive ? {
    select: createTerminalSelect(process.stdin, process.stdout),
    selectMany: createTerminalMultiSelect(process.stdin, process.stdout),
    form: createTerminalForm(process.stdin, process.stdout),
    prompt: (question: string) => {
      readline ??= createInterface({ input: process.stdin, output: process.stdout });
      return readline.question(question);
    }
  } : {})
});

readline?.close();
