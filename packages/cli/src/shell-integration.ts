import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import type { Provider } from "./types.js";

export type SupportedShell = "bash" | "zsh" | "fish" | "powershell";

export const SUPPORTED_SHELLS: readonly SupportedShell[] = ["bash", "zsh", "fish", "powershell"];
export const SHELL_ACTIVE_ENV = "ISAI_OKAY_SHELL_ACTIVE";

export interface ShellIntegrationOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  profilePath?: string;
}

export interface ShellIntegrationStatus {
  installed: boolean;
  current: boolean;
}

export const FOREGROUND_HARNESSES: ReadonlyArray<{ provider: Provider; command: string }> = [
  { provider: "codex", command: "codex" },
  { provider: "claude", command: "claude" },
  { provider: "cursor", command: "agent" },
  { provider: "opencode", command: "opencode" },
  { provider: "gemini", command: "gemini" },
  { provider: "copilot", command: "copilot" },
  { provider: "aider", command: "aider" },
  { provider: "amp", command: "amp" },
  { provider: "grok", command: "grok" },
  { provider: "muse", command: "muse" }
];

const START_MARKER = "# >>> isaiokay automatic questionnaire >>>";
const END_MARKER = "# <<< isaiokay automatic questionnaire <<<";

export const defaultHarnessCommand = (provider: Provider): string | undefined =>
  FOREGROUND_HARNESSES.find((candidate) => candidate.provider === provider)?.command;

export const shellIntegrationActive = (env: NodeJS.ProcessEnv, shell: SupportedShell): boolean =>
  env[SHELL_ACTIVE_ENV] === shell;

export const isSafeShellPath = (path: string): boolean =>
  path.length > 0
  && path.length <= 4_096
  && path.trim().length > 0
  && !/[\0-\x1f\x7f]/u.test(path)
  && (isAbsolute(path) || win32.isAbsolute(path));

export const shellReloadCommand = (shell: SupportedShell, path: string): string | null => {
  if (!isSafeShellPath(path)) return null;
  if (shell === "powershell") return `. '${path.replaceAll("'", "''")}'`;
  if (shell === "fish") return `source '${path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  return `. '${path.replaceAll("'", `'\\''`)}'`;
};

export const detectShell = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): SupportedShell | null => {
  const name = (env.SHELL ?? "").split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.exe$/u, "") ?? "";
  if (name === "bash" || name === "zsh" || name === "fish") return name;
  if (name === "pwsh" || name === "powershell") return "powershell";
  // Windows does not expose the current command shell through SHELL. PowerShell
  // is the supported native profile integration; Git Bash is detected above.
  return platform === "win32" && !env.SHELL ? "powershell" : null;
};

const windowsPowerShellProfileDirectory = (env: NodeJS.ProcessEnv): "PowerShell" | "WindowsPowerShell" => {
  const modulePath = env.PSModulePath?.toLowerCase() ?? "";
  const corePowerShell = env.POWERSHELL_DISTRIBUTION_CHANNEL !== undefined
    || /(?:^|[;])[^;]*[\\/]powershell[\\/]modules(?:;|$)/u.test(modulePath);
  return corePowerShell ? "PowerShell" : "WindowsPowerShell";
};

const windowsPowerShellProfilePath = (home: string, env: NodeJS.ProcessEnv): string => {
  const profileDirectory = windowsPowerShellProfileDirectory(env);
  const suffix = `\\${profileDirectory.toLowerCase()}\\modules`;
  const configuredModuleDirectory = (env.PSModulePath ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/gu, "").replaceAll("/", "\\").replace(/[\\]+$/u, ""))
    .find((entry) => entry.toLowerCase().endsWith(suffix));
  return configuredModuleDirectory
    ? win32.join(win32.dirname(configuredModuleDirectory), "Profile.ps1")
    : win32.join(home, "Documents", profileDirectory, "Profile.ps1");
};

export const shellIntegrationPath = (
  shell: SupportedShell,
  home: string,
  options: ShellIntegrationOptions = {}
): string => {
  if (shell === "zsh") return join(home, ".zshrc");
  if (shell === "bash") return join(home, (options.platform ?? process.platform) === "darwin" ? ".bash_profile" : ".bashrc");
  if (shell === "fish") return join(home, ".config", "fish", "conf.d", "isaiokay.fish");
  if (options.profilePath) return options.profilePath;
  return (options.platform ?? process.platform) === "win32"
    ? windowsPowerShellProfilePath(home, options.env ?? {})
    : join(home, ".config", "powershell", "profile.ps1");
};

const bashFunction = ({ provider, command }: { provider: Provider; command: string }): string => [
  `if type -P ${command} >/dev/null 2>&1 && ! declare -F ${command} >/dev/null 2>&1 && ! alias ${command} >/dev/null 2>&1${provider === "cursor" ? " && [ -d \"$HOME/.cursor\" ]" : ""}; then`,
  `  ${command}() { command isaiokay run ${provider} --command ${command} -- "$@"; }`,
  "fi"
].join("\n");

const zshFunction = ({ provider, command }: { provider: Provider; command: string }): string => [
  `if (( $+commands[${command}] )) && (( ! $+functions[${command}] )) && (( ! $+aliases[${command}] ))${provider === "cursor" ? " && [ -d \"$HOME/.cursor\" ]" : ""}; then`,
  `  ${command}() { command isaiokay run ${provider} --command ${command} -- "$@"; }`,
  "fi"
].join("\n");

const fishFunction = ({ provider, command }: { provider: Provider; command: string }): string => [
  `if command -sq ${command}; and not functions -q ${command}${provider === "cursor" ? "; and test -d \"$HOME/.cursor\"" : ""}`,
  `  function ${command}`,
  `    command isaiokay run ${provider} --command ${command} -- $argv`,
  "  end",
  "end"
].join("\n");

const powerShellFunction = ({ provider, command }: { provider: Provider; command: string }): string => [
  `if ((Get-Command ${command} -CommandType Application -ErrorAction SilentlyContinue) -and -not (Get-Command ${command} -CommandType Alias,Function -ErrorAction SilentlyContinue)${provider === "cursor" ? " -and (Test-Path (Join-Path $HOME '.cursor'))" : ""}) {`,
  `  function global:${command} { & (Get-Command isaiokay -CommandType Application -ErrorAction Stop).Source run ${provider} --command ${command} -- @args }`,
  "}"
].join("\n");

const activeMarkerFor = (shell: SupportedShell): string => shell === "fish"
  ? `set -gx ${SHELL_ACTIVE_ENV} ${shell}`
  : shell === "powershell"
    ? `$env:${SHELL_ACTIVE_ENV} = '${shell}'`
    : `export ${SHELL_ACTIVE_ENV}=${shell}`;

export const renderShellIntegration = (shell: SupportedShell): string => {
  const renderFunction = shell === "fish"
    ? fishFunction
    : shell === "zsh"
      ? zshFunction
      : shell === "powershell"
        ? powerShellFunction
        : bashFunction;
  const functions = FOREGROUND_HARNESSES.map(renderFunction).join("\n\n");
  const guard = shell === "fish"
    ? "if status is-interactive; and command -sq isaiokay"
    : shell === "zsh"
      ? "if [ -t 0 ] && [ -t 1 ] && (( $+commands[isaiokay] )); then"
      : shell === "powershell"
        ? "if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected -and (Get-Command isaiokay -CommandType Application -ErrorAction SilentlyContinue)) {"
        : "if [ -t 0 ] && [ -t 1 ] && type -P isaiokay >/dev/null 2>&1; then";
  const guardEnd = shell === "fish" ? "end" : shell === "powershell" ? "}" : "fi";
  return `${START_MARKER}\n# Generated by isaiokay. Re-run \`isaiokay shell install\` to refresh.\n${guard}\n${activeMarkerFor(shell)}\n${functions}\n${guardEnd}\n${END_MARKER}\n`;
};

const renderPreviousShellIntegration = (shell: SupportedShell): string =>
  renderShellIntegration(shell).replace(`${activeMarkerFor(shell)}\n`, "");

const renderedForLineEndings = (rendered: string, text: string): string =>
  text.includes("\r\n") ? rendered.replaceAll("\n", "\r\n") : rendered;

const markerRange = (text: string): { start: number; end: number } | null => {
  const start = text.indexOf(START_MARKER);
  const endMarkerStart = text.indexOf(END_MARKER);
  if (start === -1 && endMarkerStart === -1) return null;
  if (start === -1 || endMarkerStart === -1 || endMarkerStart < start) {
    throw new Error("Refusing to modify a malformed IsAIokay.com shell integration block.");
  }
  if (text.indexOf(START_MARKER, start + START_MARKER.length) !== -1 || text.indexOf(END_MARKER, endMarkerStart + END_MARKER.length) !== -1) {
    throw new Error("Refusing to modify duplicate IsAIokay.com shell integration blocks.");
  }
  let end = endMarkerStart + END_MARKER.length;
  if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
  else if (text[end] === "\n") end += 1;
  return { start, end };
};

const atomicWriteText = async (file: string, text: string): Promise<void> => {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await stat(file).catch(() => null);
  const mode = existing ? existing.mode & 0o777 : 0o600;
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode, flag: "wx" });
    await rename(temporary, file);
    await chmod(file, mode).catch(() => undefined);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const readOptionalText = async (file: string): Promise<string | null> => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const resolvedStartupPath = async (file: string, allowSymlink: boolean): Promise<string> => {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return file;
  if (!info.isSymbolicLink()) return file;
  if (!allowSymlink) throw new Error("Refusing to modify a symlinked app-owned shell integration file.");
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Refusing to replace a shell startup symlink whose target is missing.");
    }
    throw error;
  }
};

export const installShellIntegration = async (
  shell: SupportedShell,
  home: string,
  options: ShellIntegrationOptions = {}
): Promise<{ path: string; changed: boolean }> => {
  const path = shellIntegrationPath(shell, home, options);
  if (!isSafeShellPath(path)) throw new Error("Refusing to use an invalid shell startup path.");
  const renderedBlock = renderShellIntegration(shell);
  if (shell === "fish") {
    const target = await resolvedStartupPath(path, false);
    const current = await readOptionalText(target);
    if (current === renderedBlock) return { path, changed: false };
    if (current !== null && current !== renderPreviousShellIntegration(shell)) {
      throw new Error("Refusing to overwrite a modified IsAIokay.com Fish integration file.");
    }
    await atomicWriteText(target, renderedBlock);
    return { path, changed: true };
  }
  const target = await resolvedStartupPath(path, true);
  const current = await readOptionalText(target) ?? "";
  const lineEnding = current.includes("\r\n") || (current.length === 0 && shell === "powershell" && options.platform === "win32") ? "\r\n" : "\n";
  const block = lineEnding === "\n" ? renderedBlock : renderedBlock.replaceAll("\n", lineEnding);
  const range = markerRange(current);
  const next = range
    ? `${current.slice(0, range.start)}${block}${current.slice(range.end)}`
    : `${current}${current.length > 0 && !current.endsWith("\n") ? lineEnding : ""}${current.length > 0 ? lineEnding : ""}${block}`;
  if (next === current) return { path, changed: false };
  await atomicWriteText(target, next);
  return { path, changed: true };
};

export const uninstallShellIntegration = async (
  shell: SupportedShell,
  home: string,
  options: ShellIntegrationOptions = {}
): Promise<{ path: string; changed: boolean }> => {
  const path = shellIntegrationPath(shell, home, options);
  if (!isSafeShellPath(path)) throw new Error("Refusing to use an invalid shell startup path.");
  if (shell === "fish") {
    const target = await resolvedStartupPath(path, false);
    const current = await readOptionalText(target);
    if (current === null) return { path, changed: false };
    if (current !== renderShellIntegration(shell) && current !== renderPreviousShellIntegration(shell)) {
      throw new Error("Refusing to remove a modified IsAIokay.com Fish integration file.");
    }
    await rm(target);
    return { path, changed: true };
  }
  const target = await resolvedStartupPath(path, true);
  const current = await readOptionalText(target) ?? "";
  const range = markerRange(current);
  if (!range) return { path, changed: false };
  let next = `${current.slice(0, range.start)}${current.slice(range.end)}`;
  if (next.endsWith("\r\n\r\n")) next = next.slice(0, -2);
  else if (next.endsWith("\n\n")) next = next.slice(0, -1);
  await atomicWriteText(target, next);
  return { path, changed: true };
};

export const shellIntegrationInstalled = async (
  shell: SupportedShell,
  home: string,
  options: ShellIntegrationOptions = {}
): Promise<boolean> => {
  return (await getShellIntegrationStatus(shell, home, options)).installed;
};

export const getShellIntegrationStatus = async (
  shell: SupportedShell,
  home: string,
  options: ShellIntegrationOptions = {}
): Promise<ShellIntegrationStatus> => {
  const path = shellIntegrationPath(shell, home, options);
  if (!isSafeShellPath(path)) throw new Error("Refusing to use an invalid shell startup path.");
  const target = await resolvedStartupPath(path, shell !== "fish");
  const current = await readOptionalText(target);
  if (current === null) return { installed: false, current: false };
  if (shell === "fish") {
    const installed = current === renderShellIntegration(shell) || current === renderPreviousShellIntegration(shell);
    return { installed, current: installed && current === renderShellIntegration(shell) };
  }
  const range = markerRange(current);
  const managedBlock = range ? current.slice(range.start, range.end) : null;
  return {
    installed: range !== null,
    current: managedBlock === renderedForLineEndings(renderShellIntegration(shell), current)
  };
};
