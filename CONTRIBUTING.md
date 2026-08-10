# Contributing

Thanks for helping make current coding-model experience data more useful and honest.

## Before opening a change

1. Keep the public product model-first. Coding agents are optional report context, not leaderboard entries.
2. Never add invented ratings, textual summaries, provider intent claims, or unverified release dates.
3. Never commit `.dev.vars`, `.env`, `wrangler.jsonc`, Cloudflare resource IDs, OAuth credentials, Turnstile secrets, local Wrangler state, or session data.
4. Keep Astro server-rendered output useful without JavaScript. Add React only for focused interaction.
5. Add or update tests for behavior changes.

## Local setup

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run db:seed
npm run dev
```

## Required checks

```bash
npm run typecheck
npm run lint
npm run test:all
npm run cli:check
npm run cli:test
npm run build
npm run test:e2e
```

Contributions should explain any scoring, trust, privacy, or data-contract impact. Do not include production data in issues, fixtures, screenshots, or pull requests.
