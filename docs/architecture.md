# Architecture

## Server-first rendering

The application is an Astro SSR Worker. `/` reads a cacheable public ranking payload and emits all ranking rows, inline detail links, semantic table markup, and mobile cards on the server. The ranking table works before hydration:

- filters/sort use `GET` query parameters;
- `?item=slug#item-slug` expands an item inline;
- `?feedback=slug#feedback` gives a no-JavaScript sign-in fallback;
- SVG trend lines are Astro-rendered, not a chart framework.

React islands are deliberately constrained to account controls, sort-control convenience, feedback modal/optimistic response, and admin moderation. This keeps public ranking JavaScript small. `AccountIsland.astro` is deferred so personalized account and allowance reads do not determine the cacheability of the public ranking area.

## Data ownership

| Concern | System of record | Why |
| --- | --- | --- |
| Users, accounts, sessions, verification | Better Auth native D1 tables | Better Auth owns authentication semantics. |
| Profiles, reports, moderation, trust, settings, audits | D1 via Drizzle/D1 SQL | Relational, indexed, durable application data. |
| Rankings and public configuration | D1 source + KV cache | KV is a fast rebuildable read cache only. |
| Per-user feedback submission serialization | Durable Object + D1 | The Object serializes attempts; D1 permanently stores reports. |
| CLI credentials and attribution provenance | D1 | Device codes, hashed scoped credentials, server model aliases, and submitted context require durable consistency. |

D1 is authoritative. KV never holds authentication records, counters, uniqueness decisions, moderation state, or anything requiring immediate consistency.

## Feedback flow

```text
browser → Better Auth session → Zod validation → CF rate binding
       → conditional Turnstile verification → user-named FeedbackAllowance DO
       → D1 rolling-window query + insert → next Cron publishes a complete aggregate
```

One `FeedbackAllowance` Durable Object is addressed by each internal Better Auth user ID. A narrow per-user promise queue serializes submissions without holding `blockConcurrencyWhile()` across D1 network I/O. It checks D1’s preceding 24 hours, rejects a third report or a same-item report, honors idempotency, then inserts the report in D1. Object storage is intentionally not a feedback database.

CLI reports enter the same flow after a device-link exchange approved either by the authenticated website or an existing authenticated CLI. The Worker authenticates a hashed, scoped installation token and resolves the tool-reported model through server-owned aliases. It persists only HMACed session provenance in `feedback_context`, then forwards the normalized report to the same user-named Durable Object. Unknown model labels require confirmation; opaque routers are never reinterpreted as a hidden foundation model.

The public ranking contains models only. Agent records remain in `tracked_item` as a controlled context catalog. Both manual and CLI reports can persist an optional `agent_item_id`. Model details expose model-by-agent slices only after five eligible ratings from at least three developers; these use the same trust, fraud, moderation, recency, and Bayesian scoring rules and never mix tool context into the model leaderboard.

X-linked developer profiles are private by default. An authenticated owner can opt in to a public `/u/{username}` view. Public profile queries return only structured rating fields and agent context; comments, session hashes, trust data, risk signals, and network/device hashes never leave private application paths.

## Aggregation flow

The Cron Trigger runs every ten minutes. A compare-and-set D1 lock prevents overlapping aggregate runs. The job first reconciles multi-account device/network clusters, then recalculates the live consensus plus optional 24-hour and seven-day D1 aggregates, cleans expired risk data, locks qualified release baselines, and generates versioned KV payloads. Authentication-provider metadata is never refreshed by Cron.

Cron atomically upserts one aggregate row per model, period, and UTC day. Repeated ten-minute calculations update that day rather than appending 144 near-identical snapshots. This preserves daily chart history and period comparisons while keeping storage growth bounded. Purpose-built indexes cover latest-complete-run, item/period/time, and preceding-window lookups.

`rankings:live:v8`, `rankings:24h:v8`, `rankings:7d:v8`, and `public-config:v1` payloads include a schema version, `generatedAt`, and `expiresAt`. Missing, malformed, expired, or unavailable KV falls back to D1. A second five-minute Worker edge cache serves only public ranking HTML/item API responses; deferred account controls and every private or mutating route bypass it.

The live aggregate uses exponential recency decay rather than a moving cutoff. With the default 14-day half-life, evidence crosses midnight without a discontinuity and gradually loses influence when activity stops. The 180-day query horizon is an operational bound, not the product meaning of “today”; by then a rating’s remaining time weight is negligible. D1 still retains the authoritative report.

## Release baseline model

Recent state compares an equivalent preceding window. The stronger “Possible degradation” label additionally requires a qualified release baseline, a configured release-relative quality drop, a concurrent recent decline, and a confidence gate. It is not a causal attribution. Administrators can record `release_at`, `release_source_url`, and a version label in the protected interface. Cron creates a **prospective** baseline: it waits 48 hours, gathers the first complete seven-day post-release window, verifies minimum reports, unique reporters, time span, and confidence, then stores an immutable `aggregate.period = release_baseline` and records the lock in the audit log.

Payloads provide current quality delta, optional quality change since release, baseline quality, and evidence status (`available`, `collecting`, `insufficient_evidence`, or `no_release_baseline`). Without a documented, completed, qualified baseline, the UI says so rather than fabricating release-day performance.

## Catalog lifecycle

The catalog is deliberately more current than a fixed launch list. Reddit, provider changelogs, CLI unknown-model events, and administrator suggestions can nominate a model or agent. Social attention is only a discovery input: it never creates a score, movement badge, or rating. Before activation, an administrator verifies the stable product identity, provider, item type, official URL, exact current version label, and an official release source when available.

Scheduled discovery ingests configured HTTPS provider JSON feeds and optional credential-free Reddit sources into `catalog_candidate`. Sources fail independently, normalized provider/name keys deduplicate sightings, and provenance remains available to administrators. The protected review queue requires a verified official URL before promotion; no candidate can activate itself.

Newly admitted items start with no Developer Signal and display `Pending` until real ratings arrive. CLI aliases are server-owned so providers can change raw labels without rewriting historical reports. Superseded versions can be deactivated while their D1 history remains intact.
