# Deployment

## Automated production deploys

GitHub Actions verifies every push and pull request. A successful push to
`main` can then deploy the Worker and publish a changed CLI package. Both
release jobs are disabled by repository variables until their protected
environment secrets are configured.

Create two GitHub environments: `production` and `npm`.

Add these protected values to the `production` environment. GitHub may store all
of them as environment secrets, but the workflow deploys `TURNSTILE_SITE_KEY`
as a public Worker variable:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped token with Workers Scripts, D1, KV, and Workers Routes edit access for this account and zone. |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns the Worker and bindings. |
| `CLOUDFLARE_DATABASE_ID` | Production `is-ai-okay` D1 database UUID. |
| `CLOUDFLARE_KV_NAMESPACE_ID` | Production `PUBLIC_CACHE` KV namespace ID. |
| `TURNSTILE_SITE_KEY` | Matching public Turnstile site key, injected into Wrangler `vars`. It is stored as an environment secret only to keep all deployment assignments out of the public repository. |

Add these non-secret variables to the `production` environment:

| Variable | Purpose |
| --- | --- |
| `POSTHOG_KEY` | Optional public PostHog project key (`phc_...`). Analytics remains disabled when omitted. |
| `POSTHOG_HOST` | Upstream PostHog Cloud ingestion origin used by the same-origin `/ph` proxy. This project defaults to its PostHog US region at `https://us.i.posthog.com`; use `https://eu.i.posthog.com` only for an EU-region project. |

The browser client uses a persistent first-party anonymous identifier so PostHog can measure returning visits from the same browser. Event ingestion is forwarded through the Worker's `/ph` route to the configured cloud region; browser cookies and unrelated headers are not forwarded upstream. The integration records page views and a small allowlist of explicit product events only. It does not identify application users. Session replay, page-leave capture, autocapture, heatmaps, surveys, feature flags, performance capture, and automatic error capture are disabled in code.

The workflow generates an ephemeral production `wrangler.jsonc`, applies D1
migrations and the idempotent production bootstrap, and deploys Astro's
generated `dist/server/wrangler.json` manifest. It never puts production
identifiers or credentials into the repository or uploads application runtime
secrets from GitHub. Better Auth, GitHub OAuth, Turnstile, and administrator
secrets remain encrypted in Cloudflare and are preserved across deployments.

Wrangler validates that every secret name declared in `secrets.required` is
already configured on the Worker before deploying. `npm run deploy:preflight`
remains available for the initial manual secret setup, but CI does not receive
or rotate those runtime values.

For the CLI, create the `isaiokay` npm organization and add `NPM_TOKEN` to the
GitHub `npm` environment. The token must be a granular publishing token scoped
to `@isaiokay`. Set the repository variable `NPM_PUBLISH_ENABLED` to `true`
only after that token is present. The initial package is
`@isaiokay/cli@0.1.0`; its executable is still `isaiokay`.

After the first publish, configure npm trusted publishing for GitHub
organization `isaiokay-com`, repository `isAIOkay`, workflow `ci.yml`, and
environment `npm`. Once an OIDC publish succeeds, remove `NPM_TOKEN` and
disallow token publishing in npm. The workflow already grants only the
`id-token: write` permission needed for trusted publishing.

Enable releases with repository variables only after the corresponding
environment is complete:

```text
CLOUDFLARE_DEPLOY_ENABLED=true
NPM_PUBLISH_ENABLED=true
```

CLI publication runs only when `packages/cli` or its installer scripts change.
npm versions are immutable, so every later CLI release must bump
`packages/cli/package.json`; CI safely skips a version that is already present
instead of trying to overwrite it.

## Manual first deploy

```bash
# create an ignored deployment config and your own resources
cp wrangler.example.jsonc wrangler.jsonc
wrangler d1 create is-ai-okay
wrangler kv namespace create PUBLIC_CACHE

# apply schema before traffic
npm install
npm run deploy:preflight
npm run db:generate
npm run db:migrate:remote
wrangler d1 execute is-ai-okay --remote --file=./scripts/bootstrap-production.sql

# secrets (GitHub automation uploads the same names from environment secrets)
wrangler secret put BETTER_AUTH_SECRET
wrangler secret put DELETED_IDENTITY_SECRET
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put TURNSTILE_SECRET_KEY

# configure non-secret canonical URL/site key in Wrangler vars, then deploy
# optionally add POSTHOG_KEY and POSTHOG_HOST to Wrangler vars
npm run deploy
```

`npm run deploy` builds Astro first and deploys `dist/server/wrangler.json`, the generated Worker manifest. This is important for the official Astro custom Worker entrypoint: it delegates `fetch` to Astro while exporting `FeedbackAllowance` and `scheduled` alongside it.

## Production checklist

- Keep production D1/KV assignments in the ignored local `wrangler.jsonc` or protected GitHub environment secrets; never commit them to a public fork.
- Configure `BETTER_AUTH_URL` to the final HTTPS origin and add the exact GitHub callback URL.
- Set the Turnstile site key and secret for the same hostname.
- Restrict `ADMIN_GITHUB_USER_IDS` to stable numeric GitHub IDs or set administrator status through a controlled migration.
- Generate `DELETED_IDENTITY_SECRET` independently from the authentication secret and preserve it permanently. Rotating it would invalidate deleted-account re-registration blocks.
- Ensure the Durable Object `v1` migration is deployed before accepting reports.
- Confirm the Cron Trigger is shown in the Cloudflare dashboard.
- Keep both release-enable repository variables disabled while rotating credentials or changing production bindings.
- CI must complete typecheck, lint, all test suites, packaging checks, and the production build before either release job can start.
- Keep Cloudflare and npm credentials in their separate protected GitHub environments.

## Migrations

Drizzle creates migration SQL in `drizzle/`; the checked-in initial migration includes both Better Auth’s required D1 schema and the application tables. Do not use `drizzle push` in production. Generate a migration, review it, apply it remotely, then deploy:

```bash
npm run db:generate
npm run db:migrate:remote
wrangler d1 execute is-ai-okay --remote --file=./scripts/bootstrap-production.sql
npm run deploy
```

`scripts/seed.sql` is deliberately outside the migration directory and should only be used with local D1. Never seed development score snapshots in production.

Migration `0011_early_harrier.sql` is an intentional pre-release identity reset. It removes existing feedback, aggregates, users, sessions, and CLI credentials because an X identity cannot be safely attached to a GitHub identity. Apply it only after the GitHub OAuth App and secrets are ready; users must sign in and connect the CLI again afterward.
