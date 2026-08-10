# Anti-abuse

## Layers

1. **Cloudflare Rate Limiting bindings** apply coarse endpoint limits for auth initiation, feedback modal initialization, feedback submission, allowance reads, and admin endpoints.
2. **Better Auth + GitHub** identifies the account by GitHub's stable numeric ID, never username alone.
3. **GitHub account trust** reads public `created_at` during sign-in, blocks accounts younger than the configured minimum, and puts 7–30 day accounts on probation.
4. **Turnstile** is required for probationary accounts and suspicious/abnormally fast activity. An established GitHub account is not challenged merely because its local IsAIokay.com account is new.
5. **FeedbackAllowance Durable Object** serializes a user’s attempts and checks authoritative D1 for two reports per rolling 24h and one report per item.
6. **D1 idempotency constraint** backs the Durable Object’s replay protection across evictions/retries.
7. **Cluster signals** use keyed hashes and a persistent local device identifier to down-weight reports shared across unusual device/network clusters. Because separate users have separate Durable Objects, Cron reconciles newly formed cross-user clusters, retroactively downweights matching recent reports before aggregation, and records risk events. It does not rely on an impossible third accepted report from one user.
8. **Risk/audit data** enables temporary risk retention and human moderation.
9. **CLI device credentials** are scoped, revocable, stored only as keyed hashes in D1, and remain subject to the same GitHub trust, conditional Turnstile, Rate Limiting, and Durable Object allowance. A CLI source does not increase report weight.
10. **CLI Turnstile proofs** use payload-free, ten-minute D1 challenges bound to one user and installation. Browser completion is server-verified; the proof is single-use and the report remains only in CLI memory until submission.
11. **CLI provenance constraints** deduplicate by client event, installation/session, and user idempotency. A server-owned tool matrix limits attribution strength; mixed and opaque sessions cannot masquerade as a specific model.

Rate limiting does not replace the Durable Object/D1 allowance. KV does not participate in any abuse decision.

## Submission rules

The route validates JSON with Zod before invoking the Durable Object. It hashes IP and device material with the Better Auth secret using Web Crypto; it never persists raw IP addresses. Cron clears those hashes after the configured risk-retention window (30 days by default). D1 indexes user/time, item/time, moderation, stable GitHub IDs, and idempotency keys for bounded queries.

Moderators can approve/exclude reports and change user status. Exclusions, restorations, item edits, user-status edits, and scoring-setting changes write `audit_log` records.

## Development-only mocks

The mock GitHub endpoint and mock Turnstile pass token require both `MOCK_GITHUB_AUTH=true` and a localhost request. They are not a production fallback. Production secrets missing for Turnstile fail closed for requests that require verification.

Hooks are never an automatic voting channel. They enqueue local candidates without credentials or feedback content. Dismissals and prompt non-response are not persisted as negative feedback, and deterministic sampling is chosen before the user reports an outcome.
