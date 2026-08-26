# Architecture

## Public product

The Astro SSR Worker renders one primary public comparison on `/`: coding
subscription value. The page loads a cached 7-, 30-, or 90-day subscription
aggregate and renders the plan table, model/effort/source breakdowns, confidence
evidence, CLI onboarding, and methodology on the server.

The former model/provider quality leaderboard, its detail pages, public item
APIs, filters, rating buttons, and model SEO sitemap have been retired. Model
records remain a private catalog dependency for usage attribution, historical
feedback compatibility, and price mapping; they are not a second public product.

## Data ownership

| Concern | System of record |
| --- | --- |
| Users, accounts, sessions, verification | Better Auth D1 tables |
| User subscriptions, usage slices, quota snapshots | D1 through strict CLI ingestion |
| Subscription-plan and time-versioned model-price catalogs | Operator-verified D1 records |
| Subscription ranking snapshots | D1 source plus KV read cache |
| Optional outcome check-ins, moderation, and trust | Per-user Durable Object serialization plus D1 |
| CLI credentials and model aliases | D1 |

D1 is authoritative. KV is rebuildable and never owns authentication,
uniqueness, consent, moderation, or private usage state.

## Telemetry flow

```text
provider metadata / OpenCode hook
  → local prompt-free allowlist
  → subscription binding
  → local private state and deduplication
  → scoped authenticated upload
  → immutable D1 usage slices and quota snapshots
  → consent-filtered scheduled aggregation
  → privacy-thresholded public subscription ranking
```

The upload contract accepts token counters, model/effort/variant/tier/source
labels, quota state, timestamps, random client IDs, and HMACed provider IDs. It
rejects prompts, responses, code, paths, repository names, raw provider IDs,
cookies, and credentials. Upload and community aggregation consent are separate:
cloud history may remain private while the subscription is excluded from public
statistics.

## Subscription aggregation

Cron builds 7-, 30-, and 90-day plan snapshots. A compare-and-set D1 lease
prevents overlapping jobs. Only opted-in subscriptions from eligible accounts
qualify. Measurements remain hidden until five independent contributors exist;
the same threshold applies to every model/effort/source dimension.

API-equivalent value uses the price interval effective when each slice occurred.
At least 80% token-price coverage across at least 80% of qualifying
subscriptions is required. Complete reset-to-reset quota windows strengthen
confidence. The quality-adjusted value is 75% price-normalized allowance and 25%
optional satisfaction, then confidence-shrunk toward neutral. Public reads use
KV when fresh and otherwise read the last completed D1 snapshot without touching
raw telemetry.

## Optional outcome check-ins

Check-ins are a secondary subscription signal, not a model ranking. The CLI may
link a low-frequency result-quality response directly to a configured
subscription while retaining the reported model and coding tool as context.
The existing allowance, anti-abuse, moderation, and account-deletion protections
continue to apply. Satisfaction never changes token or quota facts.

## Scheduled maintenance

The scheduled job reconciles cross-account abuse signals, removes expired risk
data, cleans expired CLI verification challenges, runs nomination-only catalog
discovery, and recalculates subscription rankings. It no longer generates legacy
model quality scores, release baselines, or legacy ranking caches.

See [`subscription-telemetry.md`](./subscription-telemetry.md) for the complete
measurement, consent, privacy, and ranking contract.
