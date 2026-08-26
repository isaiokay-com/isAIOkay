# Subscription value scoring

The only public ranking is the coding-subscription ranking defined in
[`subscription-telemetry.md`](./subscription-telemetry.md).

## Measured value

For each opted-in subscription, usage slices are converted to API-equivalent
cost using the model-price interval effective when the usage occurred. A plan is
eligible only when model prices cover at least 80% of observed tokens for at
least 80% of qualifying subscriptions.

The median API-equivalent value per subscription is normalized against the
monthly plan price:

```text
value ratio = monthly API-equivalent value ÷ monthly subscription price
allowance score = value ratio ÷ (1 + value ratio) × 100
```

Break-even is therefore 50, 2× value is 66.7, and 10× value is 90.9 without a
hard ceiling that makes strong plans indistinguishable.

## Optional satisfaction

Result-quality check-ins normalize 1–5 answers to 0–100. They are attached to a
validated user subscription when possible and are never used to alter token or
quota facts.

```text
raw quality-adjusted value = 75% allowance score + 25% satisfaction
published score = 50 + (raw score − 50) × confidence
```

If satisfaction is unavailable, measured allowance supplies the raw score by
itself. Satisfaction is not published until its own five-contributor privacy
threshold is met.

## Confidence and publication

Confidence grows from contributor breadth, complete reset-to-reset quota
windows, and exact model/token attribution. Plans with fewer than five eligible
contributors expose no community-derived totals. Model/effort/source dimensions
must independently pass the same threshold.

The UI shows sample size, exact coverage, freshness, component scores, and
observed change from the previous daily snapshot. It does not publish a separate
provider/model quality score and does not claim that an observed decline proves
provider intent.

The former Bayesian model leaderboard code and historical aggregate tables are
retained only for data compatibility and existing moderation tests. Scheduled
maintenance no longer recalculates or publishes them.
