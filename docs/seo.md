# Search and social metadata

The public product has one search focus: the observed value of paid AI coding
subscriptions. The former provider/model quality leaderboard and its generated
model-detail pages are retired.

The homepage title, description, H1, social card, and `WebPage`/`Dataset`
structured data describe the same measurable concepts:

- tokens delivered per subscription;
- actual model and reasoning-effort mix;
- quota-window evidence;
- time-valid API-equivalent value and plan price;
- optional outcome satisfaction; and
- contributor coverage, confidence, and freshness.

## Public surfaces

- `/` is the canonical subscription ranking and setup guide.
- `/sitemap.xml` contains only the canonical public product page.
- `/llms.txt` describes subscription telemetry and its privacy thresholds.
- `/og-coding-subscription-rankings.png` is the 1200×630 social card generated
  from `/og.svg`.
- Legal, authentication, administration, API, and account/profile utilities are
  excluded from indexing or from the sitemap as appropriate.

Legacy `/{provider}/{model}` pages and public `/api/items` ranking endpoints no
longer exist. Model identity remains internal context for token attribution,
pricing, and optional subscription outcome check-ins; it is not an independent
public leaderboard.
