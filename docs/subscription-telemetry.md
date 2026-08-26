# Subscription telemetry and ranking contract

IsAIokay measures the effective coding allowance delivered by paid AI coding
subscriptions. Subjective feedback remains useful, but it is a separate,
occasional quality signal rather than the primary measurement.

## Product question

For a named subscription and price, how much observable coding usage did
subscribers receive during a provider quota window, which models and reasoning
settings produced it, and did that allowance or perceived result quality change
over time?

The product must not claim a provider "nerfed" a plan from raw token totals
alone. Model mix, reasoning effort, cache behavior, subagents, service tier, and
incomplete quota windows all change token counts. We report observed changes,
coverage, and confidence, and use "possible allowance decrease" when evidence is
strong enough.

## Identity hierarchy

These concepts are never collapsed:

```text
harness       codex, claude-code, opencode, grok-build
provider      OpenAI, Anthropic, xAI, OpenRouter
market plan   ChatGPT Pro, Claude Max 5x, Claude Max 20x
subscription  one user's private instance of a market plan
session       a private, HMACed container for related work
usage slice   the smallest token-bearing request/message/turn available
```

A session can contain many models, efforts, variants, service tiers, and
subagents. Public aggregation groups immutable usage slices; it never assigns a
whole session to whichever model happened to be visible at the start or end.

## Exact and estimated data

Every observation carries an attribution quality:

- `exact`: the harness/provider reported the value for that request or turn;
- `inferred`: joined from contemporaneous, unambiguous local context;
- `estimated`: apportioned or calculated from other measurements;
- `unknown`: retained without inventing an attribution.

Token attribution and quota attribution are separate. A provider may expose
exact tokens for `Opus + high` and only one overall weekly quota percentage. In
that case the tokens are exact while quota burn by model is estimated.

The collector retains both `requested_model` and `reported_model`. Aliases and
automatic routing are not rewritten as a hidden foundation model. Raw
`reasoning_effort` and model `variant` are retained; normalized labels are added
only when their semantics are documented. Reasoning configuration and actual
reasoning-token output are separate fields.

## Privacy boundary

The CLI may persist and upload only:

- random client event and subscription identifiers;
- HMACed session/request identifiers;
- harness, provider, plan, model, effort, variant, tier, and source labels;
- non-negative aggregate token counters and provider quota percentages;
- timestamps rounded no less precisely than required to deduplicate and place a
  usage slice in a quota window;
- collector version and attribution quality.

Prompts, responses, transcripts, code, paths, repository names, raw session
identifiers, API keys, account cookies, and provider credentials are forbidden.
The CLI rejects unexpected fields through strict schemas before upload.

Local collection is enabled per subscription. Community aggregation is a
separate opt-in. Users can export their measurements, disable aggregation while
keeping private history, or delete raw telemetry.

## Aggregation

Public plan aggregates require a minimum number of independent contributors and
must publish:

- contributor, subscription, usage-slice, and complete-window counts;
- observation period and freshness;
- model/effort/source breakdown;
- native input, cache-read, cache-write, output, and reasoning tokens;
- observed quota-window coverage;
- median allowance per subscription/window where supported;
- API-equivalent value using a time-versioned price catalog;
- attribution-quality coverage and confidence;
- optional satisfaction score and response count.

The contributor threshold applies again to every published model/effort/source
dimension. A plan reaching the threshold never makes a one-person model choice
public.

Complete reset-to-reset quota windows are the strongest allowance evidence.
Incomplete windows are useful as lower bounds but cannot be silently treated as
full allowance.

## Ranking

There is no raw-token winner. A plan ranking exposes separate dimensions:

1. observed allowance;
2. allowance per paid currency unit;
3. API-equivalent value per paid currency unit;
4. result satisfaction;
5. quality-adjusted value;
6. evidence confidence and freshness.

The default "best" score is eligible only after privacy and evidence thresholds
are met. The API-equivalent-to-price ratio is bounded as `ratio ÷ (1 + ratio)`—
so break-even is 50 while plans above break-even remain distinguishable. That
normalized value is combined with satisfaction
dimensions, then confidence-shrunk toward neutral. The UI always exposes the
component values, methodology version, price assumption, sample size, model mix,
and whether quota attribution was exact or estimated.

Changes over time are shown both for the observed model mix and, when enough
evidence exists, for a mix-adjusted comparison. Effort is part of the model SKU:
`Opus + high` is not assumed equivalent to `Sonnet + high`.

## Satisfaction

Satisfaction is optional and low-frequency. It asks whether the coding outcome
was useful, not whether token volume felt generous. A satisfaction response may
reference a recent quota window or subscription, but it never modifies usage
facts. Rankings show token/value and satisfaction separately even when a
quality-adjusted view combines them.

## Delivery phases

1. Introduce versioned storage and ingestion while preserving existing ratings.
2. Configure multiple subscriptions and collect provider-native usage slices.
3. Add quota snapshots and private per-user usage views.
4. Publish privacy-thresholded plan aggregates and model-mix breakdowns.
5. Cut the homepage over to transparent subscription rankings.
6. Add mix-adjusted trends only after real data can validate the estimator.
