# Model and tool catalog maintenance

The model catalog supports subscription measurement; it is not a public
leaderboard. It provides stable identities for token attribution, time-versioned
API pricing, model aliases reported by coding tools, and optional outcome
check-in context.

## Discovery inputs

- Unknown prompt-free model labels observed by the CLI can nominate candidates.
- Official provider changelogs, API model lists, repositories, and product
  documentation verify identity, availability, and release metadata.
- Credential-free community sources may identify something worth reviewing but
  never create a model, price, score, or ranking.
- Administrators make the final activation decision and can deactivate
  superseded identities without rewriting historical usage.

## Review requirements

For each accepted model or coding tool:

1. Record its stable provider identity and canonical key.
2. Classify it as a model or harness/tool context.
3. Verify an official product URL and version label when available.
4. Add only exact, observed CLI aliases.
5. Maintain non-overlapping model-price intervals separately in the subscription
   catalog.
6. Never seed usage, contributor counts, satisfaction, or a public score.

Scheduled discovery is nomination-only and failure-isolated. Provenance remains
in `catalog_candidate`; repeated normalized identities are deduplicated for
operator review. A candidate cannot activate itself or affect subscription
rankings until an administrator verifies it and real opted-in usage passes the
normal privacy and coverage thresholds.
