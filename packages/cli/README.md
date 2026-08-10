# `@isaiokay/cli`

`isaiokay` is a Node 22+ privacy-preserving event bridge and explicit rating client for IsAIokay.com.
It accepts a deliberately small JSON envelope from supported coding tools, reduces
it to provider/model attribution, and writes private local state atomically.

Hooks do not send network requests or prompt for input. The explicit `install`
command carefully merges or creates supported host configuration; `uninstall`
removes only IsAIokay.com-owned entries. Network access is limited to foreground
authentication and authorization, allowance checks, logout, and a rating
submission the user explicitly confirms (including one opened after `run`).

## Privacy boundary

The only event fields allowed onto disk are:

- provider;
- a conservative model identifier or `null`;
- an attribution label;
- event and record timestamps;
- a random local event ID; and
- an HMAC-SHA-256 of a supplied session/task/trajectory ID.

It never persists prompts, responses, messages, transcripts, file paths, cwd,
repository names, raw session IDs, task IDs, or trajectory IDs. The HMAC secret
is generated locally and the config/state files are written with owner-only
permissions where the platform supports them.

Local state defaults to `$XDG_CONFIG_HOME/isaiokay/config.json` and
`$XDG_STATE_HOME/isaiokay/state.json` (or `~/.config` and `~/.local/state`).
Use `--config-dir` and `--state-dir` for an isolated test or workspace location.

## Install and develop

```bash
npm install
npm run check
npm test
```

Install the `isaiokay` executable from npm:

```bash
npm install --global @isaiokay/cli
# or
pnpm add --global @isaiokay/cli
# or
bun add --global @isaiokay/cli

# Start first-run onboarding
isaiokay
```

Inspect the CLI without installing it persistently with `npx --yes @isaiokay/cli
--help`, `pnpm dlx @isaiokay/cli --help`, or `bunx @isaiokay/cli --help`. One-shot
runners may sign in and use foreground commands, but automatic integration
installation is deliberately refused: provider lifecycle hooks run later and
need `isaiokay` to remain available on `PATH`.

For repository development, run `npm run cli:build && npm install --global
./packages/cli`. The public repository also provides `scripts/install-cli.sh`
as a temporary-source fallback.

## Commands

```text
isaiokay hook --provider <provider> < event.json
isaiokay run <provider> [--command <executable>] [-- <arguments...>]
isaiokay shell [install|uninstall|status|init] [bash|zsh|fish|powershell]
isaiokay install <provider>
isaiokay install --all
isaiokay uninstall <provider>
isaiokay uninstall --all
isaiokay uninstall --all --purge
isaiokay doctor [provider]
isaiokay config [init|show|path]
isaiokay setup [--headless|--no-open]
isaiokay login [--server https://isaiokay.com] [--headless|--no-open] [--no-setup] [--json] [--no-color]
isaiokay logout
isaiokay allowance
isaiokay status
isaiokay pending [list|clear]
isaiokay prompt [ask|status|never]
isaiokay rate [submit|show|defer <seconds>|clear]
```

`hook` is intentionally noninteractive. It caps stdin at 256 KiB, performs no
network I/O, returns quickly, and exits `0` even for a rejected event so a host
tool is not broken by local telemetry storage. Its JSON response never echoes a
raw session ID or input payload.

The recommended first-run setup is:

```bash
isaiokay
```

A fresh interactive invocation signs in with X, detects supported coding CLIs,
offers their privacy-safe integrations, and offers the transparent shell
wrapper. Completion is recorded locally, so later empty invocations return to
the normal pending-rating or status behavior. Run `isaiokay setup` to repeat the
guided setup. Redirected output, CI, and one-shot runners never trigger it
implicitly. Detected integrations start selected; Space toggles an entry and
Enter confirms the explicit choice.

The shell step adds one clearly marked, removable block to `.zshrc`, `.bashrc`
on Linux, `.bash_profile` on macOS, or the PowerShell current-user profile, or
creates an isolated Fish startup file. New terminals transparently wrap detected
harness executables, so users keep typing `codex`, `claude`, `agent`, `gemini`,
and their other normal commands. `isaiokay shell uninstall` removes only this
managed integration.

To remove IsAIokay.com completely, first run `isaiokay uninstall --all --purge`. It
removes every integration entry owned by the CLI plus registered and standard
managed shell wrappers, clears the CLI's credential and local session state, and
preserves unrelated provider and shell configuration. Without `--purge`, local
account and pending-session state remain available for a reinstall.
Then remove the executable with `npm uninstall --global @isaiokay/cli` (or the
equivalent command from the package manager that installed it).

On Windows, PowerShell is the default native integration. Setup discovers common
redirected Documents locations (including OneDrive) from PowerShell's module
path. If a host uses a different profile, pass its exact all-hosts path:

```powershell
isaiokay shell install powershell --profile $PROFILE.CurrentUserAllHosts
```

The same command works with PowerShell on macOS and Linux. Git Bash is detected
as Bash. Command Prompt users can use the portable `isaiokay run <provider>`
form because `cmd.exe` has no equivalent persistent function profile.

`isaiokay run` is the underlying portable foreground integration for every supported CLI
harness. It launches the harness with inherited terminal input/output, records
only a generated HMAC session plus start/end timestamps, and checks the normal
prompt cadence after the harness releases the terminal. Eligible sessions open
the questionnaire automatically. Native hooks can add a safe model label to the
same wrapper session and, on hosts with a user-only notification surface, show
the daily reminder at the next completed turn without waiting for process exit.
With redirected input or output, the wrapper transparently launches
the harness without foreground collection, preserving pipelines and scripts.

Common harnesses have defaults:

```bash
isaiokay run codex
isaiokay run claude -- --model sonnet
isaiokay run cursor -- --resume       # runs Cursor's `agent` command
isaiokay run gemini
isaiokay run opencode
isaiokay run grok
isaiokay run muse
```

Every provider can use an explicit foreground executable, including tools with
no portable default command:

```bash
isaiokay run <provider> --command <executable> -- <arguments...>
```

The executable and arguments are never written to local state or uploaded. They
are forwarded as an argument vector; Windows `.cmd` and `.bat` shims are
resolved with platform-safe escaping. The
wrapped command must remain in the foreground until the coding session ends;
editor processes that detach should keep using their lifecycle bridge.

`isaiokay prompt` applies the local meaningful-use, local-calendar daily cap,
defer, and never-ask-again policy. Twenty minutes of accumulated activity during
the current day makes the next safe turn boundary eligible. There is no random
sampling and no hook reminder is shown more than once that day. A hook reminder
does not consume the foreground questionnaire: if no rating or dismissal resolved
the day, an eligible wrapped process can still open it on exit. `isaiokay rate` starts an interactive,
user-confirmed rating. The normal terminal flow has one selectable screen and
requires no typing: result quality and usage efficiency are the only two rating questions, and the model
row appears alongside them on the same screen. Exact observed models
start preselected, while provider-specific harnesses show only their provider's
models. Comparison and task questions are not shown; recency comes from the
recorded session time and long-term change is calculated from rating history.
Arrow keys move between fields and change values; Esc skips the check-in until
the next local day without submitting. Optional tags and comments remain available through
`--tags` and `--comment`. For automation, `rate submit` accepts `--result-quality`,
`--usage-efficiency`, `--item`, `--tags`, and `--comment` flags.
Nothing is submitted without this foreground command. Hooks may show a reminder but never call the submission path.

Foreground commands use readable terminal output by default. Pass `--json` for
machine-readable output, `--no-color` to disable ANSI color, or `--no-input` to
guarantee that a command never opens an interactive selection. `NO_COLOR` and
`TERM=dumb` are also respected. `isaiokay help <command>` shows command-specific
usage, and unknown options fail instead of being silently ignored.

With no arguments, `isaiokay` chooses the useful safe default. A genuinely fresh
interactive installation starts the complete onboarding flow. After onboarding,
it opens the one-screen rating flow only when a pending session and a valid login
are both present; otherwise it shows the compact status screen. In pipes and CI
it never prompts and displays machine-readable help instead. The human status
screen also detects supported, unconfigured CLIs on `PATH` and prints the exact
`isaiokay install <provider>` commands needed to connect them.

`login` uses a short-lived browser device code. The browser retains the Better
Auth/X session; the CLI receives only a revocable credential scoped to allowance
reads and feedback writes. The credential is stored in a separate owner-only
file. In a terminal, login shows guided browser or headless instructions and a
clear success message. Color is disabled when output is redirected, when
`NO_COLOR` is set, when `TERM=dumb`, or with `--no-color`. Pass `--json` to keep
the stable newline-delimited machine-readable login events. `logout` revokes the
credential remotely before deleting the local copy.

After an interactive login, the CLI checks `PATH` for Codex, Claude Code,
Cursor, OpenCode, Gemini CLI, GitHub Copilot CLI, Amp, and Grok Build. Any detected, not-yet-configured tools appear
in an optional Space-to-toggle checklist. Only explicitly selected integrations
are installed, and only providers with a verified automatic hook contract are
offered. Detection never executes the discovered program. Use `--no-setup` or
`--no-input` to skip this step; JSON and non-interactive logins skip it
automatically.

When login is run through `npx`, `pnpm dlx`, or `bunx`, authentication is saved
but the integration checklist is skipped with persistent-install instructions.
This prevents a temporary executable from being written into provider hooks.

Run `isaiokay install --all` (or `isaiokay install all`) to install every
detected, not-yet-configured automatic integration in one explicit operation.
The command continues if one provider fails, reports every result, and exits
nonzero when any detected integration could not be installed.

## Adapter installation

`install` attaches verified integrations for Codex, Claude Code, Cursor, OpenCode,
Gemini CLI, GitHub Copilot CLI, Amp, and Grok Build. Supported JSON settings are merged
without removing existing hook groups; Copilot, OpenCode, Amp, and Grok Build use isolated,
app-owned files or plugins. Malformed existing JSON causes a fail-closed error and is never
overwritten. `uninstall` removes only handlers containing the IsAIokay.com marker.

Cline, Windsurf, Aider, and Muse Code remain documented manual/bridge modes where
automatic mutation would rely on a UI-managed installation, an unpublished lifecycle API,
or a per-turn/process wrapper. `doctor` only checks known candidate paths and
never uploads their contents.

There is intentionally no Roo adapter.

## Safe event contracts

These are normalized input contracts for a bridge that invokes this CLI. They
are not claims that every provider emits the same JSON shape.

| Provider | Accepted signal | Attribution behavior |
| --- | --- | --- |
| Codex | `event: "model.active"` with `model` | Records only an explicitly active model. |
| Claude Code | `hook_event_name: "SessionStart"` | Reads no cwd or transcript field; model remains optional. |
| Cursor | documented `sessionStart` and `stop` hooks, or `event: "model.selected"` bridge input | `model: "Auto"` is stored as opaque (`model: null`); stop activity is recorded without auto-submitting a follow-up. |
| OpenCode v1 plugin | `session.idle`, using a model ID cached in plugin memory from assistant metadata | The installed plugin forwards only an allowlisted envelope and uses the official TUI toast API. |
| Gemini CLI | `BeforeModel` with `llm_request.model`, then `AfterAgent` | The model event records attribution; the post-turn event can display a user-only reminder. |
| GitHub Copilot CLI | `agentStop` plus `sessionEnd` | Records activity without forcing another agent turn; model remains `null`. |
| Cline bridge | `TaskComplete` or `TaskCancel`, `taskId`, `provider`, `slug` | Stores the exact safe `provider/slug` model pair. |
| Windsurf bridge | `post_cascade_response`, `trajectory_id`, `model_name` | Per-turn model attribution; trajectory ID is HMACed. |
| Amp plugin | `agent.end` with the thread ID only | Uses Amp's native notification UI; model confirmation remains required. |
| Aider wrapper | `event: "isaiokay.aider.model"` with `model` | Explicit wrapper/manual mode only. |
| Grok Build hook | `SessionStart` and `Stop` with `reason: "end_turn"` | Records lifecycle activity; ignores shutdown-only Stop events and never returns a blocking decision. |
| Muse Code wrapper | foreground `muse` process | Uses generic start/end activity with explicit model confirmation. |

Example Codex bridge input:

```bash
printf '%s\n' '{"event":"model.active","model":"gpt-5.6-codex","session_id":"opaque-provider-id"}' \
  | isaiokay hook --provider codex
```

The raw `session_id` above is used only to calculate the local HMAC and is never
written or echoed.

## Programmatic interface

The package exports `normalizeProviderEvent`, each provider normalizer,
`LocalStore`, adapter plan functions, and `providerAdapters`. Cline, Windsurf,
and Aider are exposed as manual/bridge interfaces so callers can render their
true support state rather than treating them as automatically installed.
