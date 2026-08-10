# Scoring

Ratings normalize as follows: 1→0, 2→25, 3→50, 4→75, 5→100.

| Dimension | Weight |
| --- | --- |
| Result quality | 70% |
| Usage efficiency | 30% |

The pure `src/lib/scoring.ts` module is independent of Astro routes and bindings. It is unit-tested.

## Live consensus weighting

The default homepage score is a continuously recomputed `live` aggregate, not a calendar-day total. A rating starts at full recency weight and then decays exponentially with a configurable 14-day half-life:

```text
live recency = 2 ^ (−age in days / half-life days)
```

There is no midnight reset or seven-day cliff. A 14-day-old rating retains half its original recency contribution, a 28-day-old rating retains one quarter, and an inactive item gradually returns toward the Bayesian prior as its confidence fades. The Worker reads up to 180 days of history by default; evidence at that boundary is already negligible at the configured half-life. Both values are D1-backed settings.

A rating’s effective contribution is:

```text
recency × trust weight × (1 − fraud risk) × duplicate-cluster adjustment
```

Excluded moderation reports contribute nothing. Scores are Bayesian stabilized by the D1-configurable prior score and prior weight, so a handful of reports does not look like a stable verdict. Confidence is based on weighted evidence relative to the prior.

The optional 24-hour and seven-day views remain fixed-window inspection tools. They retain the original stepped weights: 1.0 for 0–6h, 0.85 for 6–24h, 0.6 for 1–3d, and 0.35 for 3–7d. Evidence outside the selected inspection window is excluded from that view only; it is not deleted from D1 or from the default live consensus.

## Current change and states

For the live aggregate, `change` compares the current score with the closest stored live snapshot at least 24 hours earlier. Rank movement uses the same approximately 24-hour reference ordering. Fixed-window views compare equivalent non-overlapping windows.

The default Developer Signal order balances:

- 72% trust- and recency-weighted overall rating;
- 18% current confidence;
- 10% independent developer breadth, gated by current confidence;
- a cautious penalty when qualified release evidence indicates a possible regression.

The confidence gate is important: a large historical developer count cannot keep an inactive model high after its recency-weighted evidence fades.

- `Low confidence`: fewer than the configured evidence threshold.
- `Improving`: change clears the configured upward threshold.
- `Possible degradation`: a negative change clears the configured threshold **and** confidence gate.
- `Stable`: no threshold signal.

The public copy never calls an outcome a provider-caused nerf. It says “possible degradation” and explains it is a recent community signal.

## Release baseline

For an item with a moderator-recorded release date/source, the scheduler waits 48h and evaluates the first complete following seven-day period. It freezes `release_baseline` only when the D1-configured minimum report count, unique reporters, evidence span, and confidence all pass. An empty or weak window remains `insufficient_evidence`; the Bayesian prior is never presented as observed release performance. The payload then exposes `releaseBaselineResultQuality`, `resultQualityChangeSinceRelease`, and the evidence status.

“Possible degradation” requires both a configured decline from the qualified release baseline and a decline from the preceding equivalent window, plus current confidence. Otherwise the UI uses `Recent decline`, `Stable`, `Improving`, or `Low confidence`. No historical baseline is fabricated or silently backfilled. Every release evidence gate uses the same eligible-report cohort as scoring; excluded or zero-weight reports cannot qualify a baseline.

Seven-day trend charts omit days without eligible reports and render discontinuous evidence as gaps. Missing observations are never encoded as a zero score.

The MVP does not infer release dates or backfill baseline windows from undocumented historic releases. Any relock/edit of a release baseline must be an audited administrator action.
