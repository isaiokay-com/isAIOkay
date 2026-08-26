<p align="center">
  <a href="https://isaiokay.com">
    <img src="./public/logo-lockup-blue.png" alt="IsAIokay.com" width="240">
  </a>
</p>

<p align="center">
  A community measurement of what AI coding subscriptions actually deliver.
</p>

<p align="center">
  <a href="https://isaiokay.com">Website</a> ·
  <a href="https://www.npmjs.com/package/@isaiokay/cli">CLI on npm</a> ·
  <a href="./docs/architecture.md">Documentation</a>
</p>

## About

Hi, I'm [Andrés](https://x.com/andresfyi). I started IsAIokay because coding subscriptions can change without giving subscribers a useful way to compare what they receive. A plan may silently deliver fewer usable sessions, a different model mix, or more low-cost tokens while still looking unchanged on its pricing page.

The project measures provider-reported token usage, quota movement, model/version, reasoning effort, cache behavior, service tier, and main/subagent/auxiliary activity across real coding sessions. Users can configure several subscriptions and contribute privacy-safe aggregates. Together, those observations can show whether a plan's effective allowance or value appears to increase or decrease over time.

An occasional satisfaction check-in remains available because token volume is not result quality. Measured allowance and subjective outcome stay separate in the data and UI. The project is open source, including its attribution, privacy, confidence, and ranking rules.

This repository contains both parts of the project:

- the [IsAIokay.com](https://isaiokay.com) website, where subscription value, evidence, model mix, and qualitative model trends are published;
- the optional [`isaiokay` CLI](./packages/cli), which collects prompt-free usage metadata and optional check-ins close to the coding session.

You do not need an account to browse the website. GitHub sign-in is used when submitting a rating or creating a public profile.

I originally wanted to offer X sign-in as well, but the X integration needed by the project requires paid API access. IsAIokay does not make any money, so GitHub is currently the only sign-in option.

## How measurement works

The immutable unit is a usage slice: the smallest request, message, turn, or model/session total that a tool exposes reliably. Each slice can carry:

- subscription, harness, and provider;
- requested and reported model/version;
- reasoning effort or model variant;
- main-agent, subagent, auxiliary, or background source;
- input, cache-read, cache-write, output, and reasoning tokens;
- exact, inferred, estimated, or unknown attribution quality.

A session may contain many such slices. It is never assigned wholesale to the model visible at its start or end. Quota snapshots are stored separately because exact token attribution does not imply exact per-model subscription-quota burn.

Public plan rankings require at least five opted-in contributors, disclose sample size and freshness, and remain Pending unless time-valid API prices cover at least 80% of observed tokens. Raw-token totals never determine the winner. See the complete [telemetry and ranking contract](./docs/subscription-telemetry.md).

## Using the CLI

The CLI can collect token/model/effort metadata from supported coding tools, sync it to a private account, and optionally contribute it to community aggregates. It can still offer a low-frequency result-quality check-in, but never submits one on its own.

Node.js 22 or newer is required.

```bash
npm install --global @isaiokay/cli
isaiokay
```

The first run signs in through GitHub, finds installed coding tools, offers the current market-plan catalog, and asks separately whether community aggregation is allowed. Once setup is complete, continue using commands such as `codex`, `claude`, `opencode`, or `grok` normally.

Provider session files are scanned locally for allowlisted counters and labels; prompts, responses, code, paths, and raw identifiers are discarded before local state is written. Managed foreground sessions collect and sync automatically when authenticated.

Some useful commands:

```bash
isaiokay subscription list  # Show configured plans and harness bindings
isaiokay subscription consent <id> off # Stop community aggregation
isaiokay usage              # Tokens grouped by plan, model, and effort
isaiokay usage --cloud --period all # Synced usage across devices
isaiokay collect            # Scan provider metadata locally
isaiokay sync               # Upload pending prompt-free observations
isaiokay export > usage.json
isaiokay telemetry delete --yes
isaiokay status             # Show subscriptions, telemetry, and integrations
isaiokay doctor             # Check installed integrations
isaiokay rate               # Open a rating manually
isaiokay prompt status      # Explain whether a reminder is currently eligible
isaiokay install --all      # Install detected automatic integrations
isaiokay uninstall --all    # Remove integrations installed by IsAIokay
```

To remove the CLI and its local state completely:

```bash
isaiokay uninstall --all --purge
npm uninstall --global @isaiokay/cli
```

Automatic integrations are available for Codex, Claude Code, Cursor Agent, OpenCode, Gemini CLI, GitHub Copilot CLI, Amp, and Grok Build. Aider, Muse Code, Cline, and Windsurf have alternative integration paths. The [CLI guide](./docs/cli.md) explains how each one works, along with headless setup, PowerShell support, and custom commands.

## Privacy

IsAIokay is designed to measure usage, not reconstruct the work behind it. The CLI may read provider-owned JSON/JSONL records, but retains only allowlisted token, model, effort, tier, source, quota, and timestamp metadata. It does not persist or upload prompts, responses, source code, diffs, file paths, repository names, working directories, shell commands, provider credentials, or raw session/request identifiers.

Raw identifiers are HMACed locally. Collection is configured per subscription, and private storage is distinct from community aggregation consent. `isaiokay export` exposes the local minimized record; `isaiokay telemetry delete --yes` deletes local and cloud telemetry. Account deletion also removes subscriptions, usage slices, and quota snapshots.

Public profiles are optional and contain ratings only: the model, the two scores, optional coding-tool context, and submission time. See the [CLI privacy contract](./docs/cli.md#privacy-contract) and the website [Privacy Policy](https://isaiokay.com/privacy) for the full details.

## Local development

Clone the repository and prepare the local Cloudflare bindings:

```bash
git clone https://github.com/isaiokay-com/isAIOkay.git
cd isAIOkay
npm install
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed
npm run dev
```

The site will be available at [http://localhost:4321](http://localhost:4321). For local development without GitHub OAuth, add `MOCK_GITHUB_AUTH=true` to `.dev.vars`.

Common checks:

```bash
npm run typecheck
npm run lint
npm run test:all
npm run test:e2e
npm run build
npm run cli:test
```

The website is an Astro application deployed as a Cloudflare Worker. It uses React islands for interactive parts, D1 for relational data, and Better Auth with GitHub OAuth. The CLI is a separate workspace package under `packages/cli`.

More detailed setup and design notes live in [`docs`](./docs):

- [Architecture](./docs/architecture.md)
- [Cloudflare setup](./docs/cloudflare.md)
- [Deployment](./docs/deployment.md)
- [Authentication](./docs/better-auth.md)
- [Scoring](./docs/scoring.md)
- [CLI behavior](./docs/cli.md)

## Contributing

Questions, bug reports, and small improvements are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Security issues should be reported privately as described in [SECURITY.md](./SECURITY.md).

The code is available under the [MIT License](./LICENSE). Provider marks and project brand assets have separate notes in [NOTICE.md](./NOTICE.md).

For general help, email [hi@isaiokay.com](mailto:hi@isaiokay.com).
