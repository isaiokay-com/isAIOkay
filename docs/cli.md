# Session feedback CLI

`isaiokay` is the opt-in collector for feedback at the point of use. Provider adapters emit a minimal local session candidate, and an eligible lifecycle hook can show a lightweight reminder that points to `isaiokay rate`. `isaiokay run` provides a provider-independent foreground wrapper that can open the questionnaire safely after any CLI harness exits. `isaiokay prompt` provides the foreground question and cadence controls. Hooks never submit feedback and never block an agent turn.

## Privacy contract

The collector is deliberately unable to persist or upload prompts, responses, transcript contents, code, diffs, commands, repository names, working directories, or raw provider session IDs. An installation-local secret HMACs the provider session identifier before it reaches the app-owned queue. Network payloads contain only tool, raw model label, attribution quality, coarse duration bucket, adapter version, the explicit rating, and the HMAC identifier used for idempotency.

Local configuration belongs under the platform configuration directory with user-only permissions. Hook credentials are never embedded in third-party hook JSON. Device authorization grants a revocable token scoped to `allowance:read` and `feedback:write`; it never copies a Better Auth cookie or X token into the CLI.

## Adapter truth table

| Tool | Install mode | Completion signal | Model attribution | Policy |
| --- | --- | --- | --- | --- |
| Codex | Automatic owned hook | `Stop` / `SessionEnd` | Active `model` is included in hook input | Track changes and mark multi-model sessions mixed. |
| Claude Code | Automatic merged hook | `SessionStart` plus later `Stop`/`SessionEnd` | Start model only | Require confirmation because `/model` changes are invisible later. |
| Cursor | Automatic merged hook | `sessionStart` plus `stop` | Documented `model`; `Auto` stays opaque | Record completed turns without using `followup_message`, which would submit another agent turn. |
| OpenCode | Automatic isolated plugin | `session.idle` | Assistant `providerID` + `modelID` cached in plugin memory | Forward only an allowlisted envelope and notify with the native TUI toast. |
| Gemini CLI | Automatic merged hook | `BeforeModel` plus `AfterAgent` | `llm_request.model` cached by session | Notify only after the completed agent turn. |
| GitHub Copilot CLI | Automatic isolated hook | `agentStop` plus `sessionEnd` | Not exposed in documented payloads | Record unknown model without injecting or forcing an agent turn. |
| Cline | Manual bridge | `TaskComplete` / `TaskCancel` | Provider and model slug at hook time | Do not mutate editor-managed configuration. |
| Windsurf | Manual bridge | `post_cascade_response` | `model_name` when available | Debounce by trajectory; it is a per-response event. |
| Amp | Automatic isolated plugin | `agent.end` | Usually unavailable | Use native `ctx.ui.notify`; require model confirmation. |
| Aider | Manual wrapper | Process wrapper only | Initial flag/config only | Manual confirmation because `/model` can change it. |
| Grok Build | Automatic isolated hook | `SessionStart` plus genuine `Stop` (`reason: end_turn`) | Not retained from lifecycle input | Ignore the extra shutdown Stop and never return a gate decision. |
| Muse Code | Manual wrapper | Foreground process exit | Manual confirmation | Meta's installer verifies the `muse` command, but no stable public lifecycle hook contract is available yet. |

Roo Code is intentionally excluded from new integration work because its official extension and repository were retired in 2026. Tools without a stable lifecycle API use the generic/manual adapter instead of filesystem or transcript scraping.

## First-run setup and login

On a fresh persistent installation, running bare `isaiokay` in an interactive
terminal launches the complete onboarding exactly once. `isaiokay setup`
explicitly reruns it. Existing users, redirected output, JSON commands, CI, and
pending-rating flows keep their established behavior.

Detected integrations start selected; use Space to toggle any entry and Enter
to continue. Every provider change and the shell wrapper remain opt-in steps.

1. `isaiokay` requests a short-lived device code from `/api/cli/device/start`.
2. The CLI opens `/cli/authorize` and displays the same human-readable code.
3. The authenticated user explicitly approves it.
4. The CLI polls `/api/cli/device/token` and receives a one-year, revocable scoped credential.
5. Only the token hash is stored in D1. The plaintext credential remains local.

Device codes expire after ten minutes and can be consumed only by the approved user. `isaiokay logout` revokes the server credential before removing local state when the network is available.

### Headless login

`isaiokay` and `isaiokay setup` detect whether the current environment can launch a graphical browser. macOS and Windows desktop sessions use the browser flow; Linux and BSD require a graphical display (`DISPLAY`, `WAYLAND_DISPLAY`, or `MIR_SOCKET`). CI and machines without a display automatically use headless mode. If a detected browser launcher fails, setup also falls back to headless mode without abandoning the device code. `isaiokay login` remains available as the explicit authentication entry point; pass `--no-setup` when only authentication is wanted.

For a remote machine, run the normal command and leave it polling:

```bash
# On the headless machine. --headless is optional and forces the fallback.
isaiokay setup --headless
# The CLI prints the authorization link, one-time code, and the command below.
# Already signed in elsewhere? Run there:
# isaiokay authorize ABCD-EFGH

# On another machine where the CLI is already authenticated.
isaiokay authorize ABCD-EFGH
```

The authenticated CLI approves only that one-time code. No long-lived credential is printed, copied, passed on the command line, or shared between machines. A first installation still requires the X authorization page to establish the account; after that, any additional terminal can be connected entirely from the CLI. Set `ISAI_OKAY_HEADLESS=1` or pass `--headless` to force terminal mode; set `ISAI_OKAY_BROWSER=1` to force a browser launch attempt.

Interactive terminals receive a guided, colored login flow. Use `--no-color` or
set `NO_COLOR` to disable color. Redirected output stays machine-readable, and
`isaiokay login --json` explicitly emits the authorization and success events as
newline-delimited JSON.

After login succeeds, an interactive terminal safely checks `PATH` for Codex,
Claude Code, Cursor, OpenCode, Gemini CLI, GitHub Copilot CLI, Amp, and Grok Build. Detected automatic integrations
that are not already configured appear in an optional checklist: use Space to
toggle tools and Enter to install the selection. The detector checks executable
permissions but never launches a discovered CLI. Manual/bridge-only providers
are not offered for automatic mutation. Pass `--no-setup` or `--no-input` to
skip setup; redirected and JSON login flows always skip it.

`isaiokay install --all` installs every detected, unconfigured provider from
that safe automatic set. `isaiokay install all` is an equivalent alias. Each
provider result is reported separately so a malformed configuration in one tool
does not prevent the others from being attempted.

## Local commands

```bash
# Install persistently with your package manager
npm install --global @isaiokay/cli
isaiokay
# or
pnpm add --global @isaiokay/cli
# or
bun add --global @isaiokay/cli

# Preview without a persistent install
npx --yes @isaiokay/cli --help
pnpm dlx @isaiokay/cli --help
bunx @isaiokay/cli --help

# Repository-source fallback
curl -fsSL https://raw.githubusercontent.com/isaiokay-com/isAIOkay/main/scripts/install-cli.sh | sh

# Or install from an existing checkout
npm run cli:build
npm install --global ./packages/cli

isaiokay setup
isaiokay install --all
isaiokay install codex
isaiokay install claude
isaiokay install cursor
isaiokay install opencode
isaiokay install gemini
isaiokay install copilot
isaiokay install amp
isaiokay install grok
isaiokay shell install
# PowerShell with an unusual/non-default profile:
isaiokay shell install powershell --profile $PROFILE.CurrentUserAllHosts
isaiokay run codex
isaiokay run claude -- --model sonnet
isaiokay run cursor -- --resume
isaiokay run grok
isaiokay run muse
isaiokay run <provider> --command <executable> -- <arguments...>
isaiokay doctor
isaiokay allowance
isaiokay prompt
isaiokay rate
```

One-shot runners support safe foreground inspection and account commands, but
they cannot install automatic integrations. Codex, Claude Code, Cursor, OpenCode, Gemini,
Copilot, Amp, and Grok Build lifecycle hooks run after the one-shot process exits and therefore need
a persistent `isaiokay` executable on `PATH`. A one-shot login saves the scoped
credential, skips the integration selector, and prints the persistent install
commands; a one-shot `install` command exits before changing provider files.

### Automatic foreground questionnaire

Users do not need to change their everyday harness commands. The one-time
command `isaiokay shell install` supports Bash, Zsh, Fish, and PowerShell on
Linux, macOS, and Windows. It adds a clearly marked managed block to the user's
shell startup configuration; Fish uses an isolated startup file. In each new
terminal, detected harness executables are transparently routed through the
foreground collector; users continue typing `codex`, `claude`, `agent`,
`gemini`, `opencode`, and the other normal commands. The onboarding flow offers this
setup explicitly, and `isaiokay shell uninstall` removes only the managed block.

`isaiokay uninstall --all` removes all IsAIokay.com-owned provider handlers and
every registered or standard managed shell wrapper, then prints the package-manager
command that removes the global CLI. Add `--purge` for a complete reset of the
CLI credential, settings, and pending-session state. Purge attempts to revoke
the credential remotely but still completes local cleanup while offline. Neither
mode deletes unrelated provider or shell configuration.

Windows defaults to PowerShell when no Unix-style `SHELL` is present, while Git
Bash remains Bash. Common redirected Documents folders (for example OneDrive)
are discovered from `PSModulePath`; unusual hosts can supply the exact all-hosts
profile explicitly with `--profile $PROFILE.CurrentUserAllHosts`. The command
shown above also covers non-default PowerShell hosts on macOS and Linux. Bash
uses `.bashrc` on Linux and `.bash_profile` on macOS.
Command Prompt has no persistent function profile, so its portable fallback is
`isaiokay run <provider>`.

`isaiokay run` is the underlying mechanism. It supports every provider in the adapter registry without making a
background hook compete for terminal input. It creates an installation-local
random session identifier, persists only its HMAC plus start/end timestamps,
launches the requested harness with inherited stdio, and evaluates the normal
prompt policy once that process exits. When the session is eligible, the
interactive questionnaire opens in the terminal that the harness just released.
If input or output is redirected, the wrapper passes the harness through without
collecting a foreground session or opening a questionnaire, so pipelines,
scripts, and output redirection keep their normal behavior.

Codex, Claude Code, Cursor Agent, OpenCode, Gemini CLI, Copilot CLI, Aider, Amp,
Grok Build, and Muse Code have default executable names. Use `--command <executable>` for any custom
binary, renamed command, or provider without a portable terminal executable.
Place all harness arguments after `--`; they are forwarded as an argument vector
and are never stored or uploaded. Windows `.cmd` and `.bat` launchers use
platform-safe resolution and escaping rather than constructing a command line
from user input.

Native hooks remain useful for model attribution. While a harness is wrapped,
its hooks join the foreground session. A safe post-turn hook may show the daily
reminder immediately, so a long-running process does not need to exit first.
Claude Code's documented `SessionStart` model is retained for the matching
session and preselected later; because Claude can switch models after startup,
the developer can still correct that row before submitting. Model choices are
scoped to the harness when its provider is known (for example, Anthropic for
Claude Code and OpenAI for Codex). Multi-provider routers such as OpenCode keep
the broader catalog. If a harness exposes no safe model signal, the same row
asks the developer to confirm it. A detached editor launcher cannot be timed by
a process wrapper, so editor-native integrations continue to use their documented bridge.

Shell integration is opt-in and fail-closed: malformed or duplicate managed
markers are never overwritten. Existing startup content and file permissions
are preserved, harness arguments remain a distinct argument vector, and
the original harness exit status is returned unchanged.

`isaiokay rate` is a zero-typing, one-screen flow in an interactive terminal:

```text
? Quick check-in
  ❯ Model                               ‹ Claude Sonnet 5 (Anthropic) ›
    How good was the result?            ‹ 3 — Okay ›
    Did progress feel worth the usage?  ‹ 3 — About expected ›
  ↑/↓ field · ←/→ change · Enter send · Esc skip today
```

The interactive flow keeps the model on this same screen and starts on an exact
catalog match when one was observed. Provider-specific harnesses show only that
provider's models; multi-provider tools keep the broader catalog. Result quality captures whether the
session produced a useful, correct outcome. Usage efficiency captures whether
that progress felt worth the subscription allowance or metered usage consumed. The
CLI does not ask developers to estimate comparison, task type, or recency:
long-term change is calculated from rating history, unknown task context remains
unspecified, and session timing supplies recency. The flow never asks for typed
text. Optional tags and comments are advanced flag-only fields. Piped or CI
execution never prompts; automation can use `--result-quality`,
`--usage-efficiency`, and `--item`, and can request JSON output.

Running `isaiokay` without a subcommand starts onboarding on a fresh interactive
installation. Once onboarding is complete, it starts the rating flow when a
signed-in pending session exists; if nothing is ready to rate, it shows status
and the next useful command. A non-interactive empty invocation prints help and
never prompts. Status checks supported executables on `PATH`; detected tools
without an installed integration are listed with their exact installation
commands.

The repository installer requires Node 22+, downloads the selected public GitHub source archive into a temporary directory, installs locked dependencies with lifecycle scripts disabled, builds only the CLI, and installs that local package globally. Set `ISAIOKAY_REF` to pin a tag or commit.

Codex, Claude Code, Cursor, and Gemini CLI use carefully merged lifecycle hook groups. OpenCode, Copilot, Amp, and Grok Build use isolated app-owned files or plugins. Existing valid configuration is preserved, malformed JSON fails closed, and uninstall removes only IsAIokay.com-owned entries. Cline, Windsurf, Aider, and Muse Code return explicit manual bridge or wrapper instructions because their safest integration requires an editor-specific UI workflow, debounce layer, process wrapper, or a lifecycle API that is not yet public.

## Attribution and scoring

The server, not the CLI, maps a raw model label to `tracked_item`. `model_alias` provides versioned per-tool mappings. Unknown labels, opaque routing, and mixed sessions return a confirmation-required response with the active model catalog. The host agent is stored separately as report context and is never ranked in place of a model. A client cannot submit an authoritative tracked-item ID.

CLI feedback uses the same trust weight, Turnstile policy, Rate Limiting binding, two-per-day rolling allowance, one-item-per-window limit, moderation, and scheduled aggregation as browser feedback. When Turnstile is required, the CLI opens a short-lived browser challenge, polls only its status, and retries the in-memory report with a single-use proof. The challenge stores no rating payload. CLI provenance does not receive additional trust weight.

The website and CLI collect the same two answers: result quality and usage
efficiency. Neither asks the developer to estimate a trend; movement is derived
from repeated ratings over time. The terminal check-in optimizes for completion
by putting the detected model and both answers on one screen. Both surfaces use
the same privacy, trust, moderation, and aggregation pipeline.

## Prompt policy

Hooks only enqueue and may return a host-visible reminder; they never submit. Activity from multiple sessions accumulates during the user's local calendar day. After twenty minutes of experience, the next safe completed-turn boundary can show one reminder; there is no random sampling and no weekly suppression. Hooks without a native user-only surface only record activity. A hook reminder has its own daily cap and never consumes the foreground questionnaire slot, because a host returning `systemMessage` does not prove the developer saw it. A wrapped long-running host can therefore notify at a safe turn boundary, while an eligible process exit still opens the questionnaire unless a foreground prompt, rating, dismissal, deferral, or disabled-reminders choice has resolved the day. Old pending activity cannot trigger a new day's reminder. `isaiokay prompt never` disables prompts, while `isaiokay rate clear` resets the local cadence. Dismissals are not negative ratings. Every submission requires a deliberate user action.

The initial model catalog and aliases are intentionally conservative and sourced from current provider documentation: GPT-5.6 Sol/Terra/Luna, Claude Fable/Opus/Sonnet 5, and Gemini 3.5/3.6 Flash plus Gemini 3.1 Pro. Unknown labels still require explicit confirmation; aliases are never inferred from arbitrary text.

## Official integration references

- [Codex hooks](https://developers.openai.com/codex/config-advanced#hooks)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks) and [CLI output](https://docs.cursor.com/en/cli/reference/output-format)
- [Grok Build overview](https://docs.x.ai/build/overview), [hooks](https://docs.x.ai/build/features/hooks), and [CLI reference](https://docs.x.ai/build/cli/reference)
- [Muse Code official installer](https://dev.meta.ai/install.sh)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Gemini CLI hook reference](https://geminicli.com/docs/hooks/reference/)
- [GitHub Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Cline hooks](https://docs.cline.bot/customization/hooks)
- [Windsurf hooks](https://docs.windsurf.com/windsurf/cascade/hooks)
- [Amp plugin API](https://ampcode.com/manual/plugin-api)
- [Aider configuration](https://aider.chat/docs/config/options.html)
- [OpenAI current models](https://developers.openai.com/api/docs/models)
- [Claude current models](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Gemini current models](https://ai.google.dev/gemini-api/docs/models)
