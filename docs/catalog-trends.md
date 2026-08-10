# Catalog trend watch

The leaderboard must follow what developers are actually using, not preserve a static vendor list. Catalog discovery and community scoring are separate systems.

## Discovery inputs

- Credential-free developer community sources such as Reddit can nominate candidates.
- Unknown model labels observed by the privacy-preserving CLI can nominate candidates after user confirmation.
- Official provider changelogs, API model lists, repositories, and product documentation verify identity and release metadata.
- Administrators make the final activation decision and can deactivate superseded entries without deleting history.

Social post volume is not a rating and never affects Developer Signal. It only tells the catalog curator what should be investigated. An item is activated only when its exact provider identity and an official product or model reference can be verified. Preview status is shown in the item name when relevant.

## Review cadence

Review candidate activity at least weekly and after major provider announcements. Prioritize repeated mentions tied to real coding use, CLI unknown-label frequency, and models appearing across multiple coding tools. Avoid adding one-off fine-tunes, aliases that point to an existing model, or speculative unreleased names.

For each accepted item:

1. Record the stable slug and provider identity.
2. Classify it as a model or agent.
3. Record the official product URL and current version label.
4. Record a dated official release source when available.
5. Add CLI aliases for exact observed labels.
6. Start at `Pending`; never seed a score, developer count, movement, or trend.

## Current additions

- DeepSeek V4 Flash uses the official `deepseek-v4-flash` API identity and the July 31, 2026 official release reference.
- Qwen 3.8 Max Preview uses the official Qwen Code model label `qwen3.8-max-preview` and remains explicitly labeled as a preview.
- Qwen Code is retained in the agent-context catalog, while Qwen foundation models are tracked as rankable models. Tool experience and model experience answer different questions and must not be merged into one score.

Scheduled maintenance can ingest administrator-configured HTTPS provider JSON feeds plus optional Reddit JSON listings. Each source is failure-isolated, provenance is retained in `catalog_candidate`, and repeated normalized identities are deduplicated into one review record. Reddit is disabled until an administrator configures a public listing URL.

Automation remains nomination-only. The protected catalog queue requires an administrator to verify an official product URL before promotion. Promotion creates an active catalog item with `Pending` signal and no score, movement, or invented history. Social post volume and candidate sighting counts never enter aggregation.
