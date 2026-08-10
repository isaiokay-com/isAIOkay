# Cloudflare services

`wrangler.jsonc` targets a Cloudflare Worker directly. It does not use Cloudflare Pages Functions.

## Required resources

1. Create D1: `wrangler d1 create is-ai-okay`.
2. Create KV: `wrangler kv namespace create PUBLIC_CACHE`.
3. Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`, then place the returned IDs in that local file. In GitHub Actions, `scripts/prepare-cloudflare-config.mjs` builds the same ignored file from protected `CLOUDFLARE_DATABASE_ID` and `CLOUDFLARE_KV_NAMESPACE_ID` environment secrets. The public repository excludes the live assignments.
4. Durable Object namespace `FEEDBACK_ALLOWANCE` is declared in the Worker configuration. Deploy once to apply its `v1` SQLite class migration.
5. Configure the five account-unique Rate Limiting namespaces (`AUTH_RATE_LIMIT`, `FEEDBACK_MODAL_RATE_LIMIT`, `FEEDBACK_RATE_LIMIT`, `ALLOWANCE_RATE_LIMIT`, `ADMIN_RATE_LIMIT`). The supplied numeric IDs are the non-secret assignments used by this deployed project; forks need their own assignments.
6. Create a Turnstile managed widget for the production hostname. The deployment workflow uploads `TURNSTILE_SECRET_KEY` as an encrypted Worker secret and injects the public `TURNSTILE_SITE_KEY` into the generated Wrangler `vars` configuration.
7. The `*/10 * * * *` Cron Trigger is declared in Wrangler; deploy activates it.

No R2 bucket is required for MVP. Static/version-controlled assets or official remote logo URLs are sufficient. R2 should only be introduced for real uploads, generated OG images, or moderation exports.

The production API token must be scoped to the single Cloudflare account and
`isaiokay.com` zone. It needs only the permissions required to deploy Worker
scripts and routes, apply D1 migrations, and update the bound KV namespace.
Keep `CLOUDFLARE_DEPLOY_ENABLED` disabled whenever those credentials are absent
or being rotated.

## Bindings

| Binding | Role |
| --- | --- |
| `DB` | Authoritative Cloudflare D1 database. |
| `PUBLIC_CACHE` | Public aggregate/config cache only. |
| `FEEDBACK_ALLOWANCE` | Per-user Durable Object namespace. |
| `*_RATE_LIMIT` | Endpoint-level supplementary abuse controls. |

Astro’s unused session storage is explicitly configured with an in-memory driver; it does not provision a second KV namespace. Better Auth sessions are stored in D1. Cloudflare image processing is set to passthrough, so no Images binding is provisioned.

## KV discipline

Every written public payload includes `schemaVersion`, `generatedAt`, and `expiresAt`. The cron commits a complete D1 aggregate period first and then replaces its versioned KV payload. Feedback does not write a shared invalidation key: the existing aggregate remains the truthful public result until the next ten-minute calculation. Zod rejects malformed payloads, and pages survive KV misses or service errors because `loadPublicRanking()` reads D1.

The named Worker Cache API stores only successful public item API responses for five minutes. Cache keys normalize the supported period query space; HTML is deliberately excluded because Astro server-island URLs are tied to a specific build and must not survive deployments in cached markup. Profiles, auth, feedback, CLI, and admin routes are also never stored. Public ranking payloads remain cached in KV, so normal page rendering does not repeatedly calculate rankings from reports.

Never use KV for report allowances, auth, report idempotency, financial state, or moderation decisions.

## Local emulation

Wrangler local state provides D1, KV, Durable Objects, and bindings. Run local migrations before the production-shaped Worker preview:

```bash
npm run db:migrate:local
npm run db:seed
npm run dev:worker
```

`MOCK_GITHUB_AUTH=true` enables only `localhost`/loopback mock GitHub identities and mock Turnstile token `mock-turnstile-pass`. The production Worker neither recognizes that mock cookie nor bypasses Turnstile.
