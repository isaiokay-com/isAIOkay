import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

// Better Auth's native D1 adapter owns the lifecycle semantics for these four
// tables. They are declared here solely so Drizzle produces one D1 migration.
export const authUser = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
    image: text("image"),
    githubUsername: text("githubUsername"),
    githubAccountCreatedAt: integer("githubAccountCreatedAt"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull()
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)]
);

export const authSession = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull()
  },
  (table) => [uniqueIndex("session_token_unique").on(table.token), index("session_user_id_idx").on(table.userId)]
);

export const authAccount = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: integer("accessTokenExpiresAt"),
    refreshTokenExpiresAt: integer("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull()
  },
  (table) => [
    uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId),
    index("account_user_id_idx").on(table.userId)
  ]
);

export const authVerification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    createdAt: integer("createdAt").notNull(),
    updatedAt: integer("updatedAt").notNull()
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

export const trackedItem = sqliteTable(
  "tracked_item",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    providerName: text("provider_name").notNull(),
    type: text("type", { enum: ["model", "agent"] }).notNull(),
    description: text("description"),
    logoUrl: text("logo_url"),
    officialUrl: text("official_url").notNull(),
    pricingSummary: text("pricing_summary"),
    pricingLastVerifiedAt: integer("pricing_last_verified_at"),
    versionLabel: text("version_label"),
    releaseAt: integer("release_at"),
    baselineStartAt: integer("baseline_start_at"),
    baselineEndAt: integer("baseline_end_at"),
    baselineLockedAt: integer("baseline_locked_at"),
    baselineMethodVersion: text("baseline_method_version"),
    releaseSourceUrl: text("release_source_url"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [uniqueIndex("tracked_item_slug_unique").on(table.slug), index("tracked_item_active_sort_idx").on(table.isActive, table.sortOrder)]
);

/**
 * Nomination-only model/agent discovery queue.
 *
 * Social discussion and provider release feeds may upsert rows here, but a
 * candidate can never influence a score, movement badge, trend, or rating.
 * Only an administrator can promote a candidate to a `tracked_item`, which
 * starts at `Pending` with no seeded signal.
 */
export const catalogCandidate = sqliteTable(
  "catalog_candidate",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Deduplication key derived from the normalized name plus provider. */
    normalizedKey: text("normalized_key").notNull(),
    providerName: text("provider_name").notNull(),
    type: text("type", { enum: ["model", "agent"] }).notNull(),
    source: text("source", { enum: ["provider_release", "reddit", "cli", "admin"] }).notNull(),
    sourceUrl: text("source_url"),
    rawLabel: text("raw_label"),
    versionLabel: text("version_label"),
    releaseAt: integer("release_at"),
    /** Last-n-seen provenance entries: { source, url, seenAt, detail }. */
    provenanceJson: text("provenance_json").notNull().default("[]"),
    status: text("status", { enum: ["pending", "promoted", "dismissed"] }).notNull().default("pending"),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("catalog_candidate_normalized_unique").on(table.normalizedKey),
    index("catalog_candidate_status_seen_idx").on(table.status, table.lastSeenAt)
  ]
);

export const userProfile = sqliteTable(
  "user_profile",
  {
    userId: text("user_id").primaryKey().references(() => authUser.id, { onDelete: "cascade" }),
    githubUserId: text("github_user_id").notNull(),
    githubUsername: text("github_username").notNull(),
    githubDisplayName: text("github_display_name"),
    githubAvatarUrl: text("github_avatar_url"),
    githubAccountCreatedAt: integer("github_account_created_at").notNull(),
    xUsername: text("x_username"),
    trustCategory: text("trust_category", { enum: ["blocked", "probation", "normal", "trusted"] }).notNull().default("probation"),
    trustWeight: real("trust_weight").notNull().default(0.55),
    status: text("status", { enum: ["active", "suspended", "admin", "deleted"] }).notNull().default("active"),
    publicProfileEnabled: integer("public_profile_enabled", { mode: "boolean" }).notNull().default(false),
    firstLoginAt: integer("first_login_at").notNull(),
    lastLoginAt: integer("last_login_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (table) => [
    uniqueIndex("user_profile_github_user_id_unique").on(table.githubUserId),
    uniqueIndex("user_profile_github_username_unique").on(sql`lower(${table.githubUsername})`),
    index("user_profile_status_idx").on(table.status)
  ]
);

/**
 * A keyed one-way marker is retained after self-deletion so the same GitHub
 * identity cannot create a fresh account and reset voting limits.
 */
export const deletedIdentity = sqliteTable("deleted_identity", {
  identityHash: text("identity_hash").primaryKey(),
  deletedAt: integer("deleted_at").notNull()
});

export const feedbackReport = sqliteTable(
  "feedback_report",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "restrict" }),
    trackedItemId: text("tracked_item_id").notNull().references(() => trackedItem.id, { onDelete: "restrict" }),
    agentItemId: text("agent_item_id").references(() => trackedItem.id, { onDelete: "set null" }),
    resultQualityRating: integer("result_quality_rating").notNull(),
    usageEfficiencyRating: integer("usage_efficiency_rating").notNull(),
    tagsJson: text("tags_json").notNull(),
    shortComment: text("short_comment"),
    effectiveWeight: real("effective_weight").notNull(),
    moderationStatus: text("moderation_status", { enum: ["pending", "approved", "excluded"] }).notNull().default("pending"),
    fraudRiskScore: real("fraud_risk_score").notNull().default(0),
    duplicateClusterAdjustment: real("duplicate_cluster_adjustment").notNull().default(1),
    includedInScores: integer("included_in_scores", { mode: "boolean" }).notNull().default(true),
    ipHash: text("ip_hash"),
    deviceHash: text("device_hash"),
    idempotencyKey: text("idempotency_key").notNull(),
    source: text("source", { enum: ["web", "cli"] }).notNull().default("web"),
    feedbackContextId: text("feedback_context_id"),
    clientEventId: text("client_event_id"),
    submittedAt: integer("submitted_at").notNull(),
    editedAt: integer("edited_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("feedback_report_user_idempotency_unique").on(table.userId, table.idempotencyKey),
    uniqueIndex("feedback_report_client_event_unique").on(table.clientEventId),
    uniqueIndex("feedback_report_context_unique").on(table.feedbackContextId),
    index("feedback_report_user_submitted_idx").on(table.userId, table.submittedAt),
    index("feedback_report_item_submitted_idx").on(table.trackedItemId, table.submittedAt),
    index("feedback_report_agent_submitted_idx").on(table.agentItemId, table.submittedAt),
    index("feedback_report_moderation_idx").on(table.moderationStatus, table.submittedAt),
    index("feedback_report_ip_submitted_idx").on(table.ipHash, table.submittedAt),
    index("feedback_report_device_submitted_idx").on(table.deviceHash, table.submittedAt),
    check("feedback_result_quality_range", sql`${table.resultQualityRating} between 1 and 5`),
    check("feedback_usage_efficiency_range", sql`${table.usageEfficiencyRating} between 1 and 5`),
    check("feedback_comment_length", sql`${table.shortComment} is null or length(${table.shortComment}) <= 500`)
  ]
);

export const cliDeviceAuthorization = sqliteTable(
  "cli_device_authorization",
  {
    id: text("id").primaryKey(),
    deviceCodeHash: text("device_code_hash").notNull(),
    userCode: text("user_code").notNull(),
    status: text("status", { enum: ["pending", "approved", "consumed", "expired"] }).notNull().default("pending"),
    userId: text("user_id").references(() => authUser.id, { onDelete: "cascade" }),
    clientName: text("client_name").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    approvedAt: integer("approved_at"),
    consumedAt: integer("consumed_at")
  },
  (table) => [
    uniqueIndex("cli_device_authorization_code_unique").on(table.deviceCodeHash),
    uniqueIndex("cli_device_authorization_user_code_unique").on(table.userCode),
    index("cli_device_authorization_expiry_idx").on(table.status, table.expiresAt)
  ]
);

export const cliInstallation = sqliteTable(
  "cli_installation",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull(),
    scopesJson: text("scopes_json").notNull().default('["allowance:read","feedback:write","subscriptions:write","usage:write","usage:read"]'),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at")
  },
  (table) => [
    uniqueIndex("cli_installation_token_unique").on(table.tokenHash),
    index("cli_installation_user_idx").on(table.userId, table.createdAt),
    index("cli_installation_expiry_idx").on(table.expiresAt, table.revokedAt)
  ]
);

/**
 * A deliberately payload-free browser proof handoff for a CLI submission.
 *
 * The record only establishes that this user verified from a browser for this
 * specific CLI installation. The CLI keeps its report locally and retries it
 * after polling for the short-lived proof; D1 never stores that report here.
 */
export const cliTurnstileChallenge = sqliteTable(
  "cli_turnstile_challenge",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull().references(() => cliInstallation.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "verified", "consumed", "expired"] }).notNull().default("pending"),
    requiresTurnstile: integer("requires_turnstile", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    verifiedAt: integer("verified_at"),
    consumedAt: integer("consumed_at")
  },
  (table) => [
    index("cli_turnstile_challenge_installation_status_idx").on(table.installationId, table.status, table.expiresAt),
    index("cli_turnstile_challenge_user_expiry_idx").on(table.userId, table.expiresAt)
  ]
);

export const modelAlias = sqliteTable(
  "model_alias",
  {
    id: text("id").primaryKey(),
    tool: text("tool").notNull(),
    rawLabel: text("raw_label").notNull(),
    normalizedLabel: text("normalized_label").notNull(),
    trackedItemId: text("tracked_item_id").notNull().references(() => trackedItem.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("model_alias_tool_label_unique").on(table.tool, table.normalizedLabel),
    index("model_alias_item_idx").on(table.trackedItemId)
  ]
);

export const feedbackContext = sqliteTable(
  "feedback_context",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull().references(() => cliInstallation.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id"),
    trackedItemId: text("tracked_item_id").notNull().references(() => trackedItem.id, { onDelete: "restrict" }),
    sessionHash: text("session_hash").notNull(),
    tool: text("tool").notNull(),
    rawModelLabel: text("raw_model_label"),
    attribution: text("attribution", { enum: ["verified_active", "verified_start_only", "model_at_end", "user_confirmed", "mixed", "opaque_router", "unknown"] }).notNull(),
    adapterVersion: text("adapter_version").notNull(),
    sessionDurationBucket: text("session_duration_bucket", { enum: ["under_10m", "10_30m", "30_60m", "over_60m", "unknown"] }).notNull().default("unknown"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("feedback_context_session_unique").on(table.installationId, table.sessionHash),
    index("feedback_context_item_tool_idx").on(table.trackedItemId, table.tool, table.createdAt),
    index("feedback_context_subscription_idx").on(table.subscriptionId, table.createdAt),
    index("feedback_context_user_idx").on(table.userId, table.createdAt)
  ]
);

/**
 * A market plan, not an individual account. Public comparisons are grouped by
 * this table so "Claude Max 5x" never gets mixed with "Claude Max 20x" or a
 * metered API account. The row identifies the market tier; termsVersion records
 * which public terms were verified, while daily aggregates preserve history.
 */
export const subscriptionPlan = sqliteTable(
  "subscription_plan",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    providerName: text("provider_name").notNull(),
    name: text("name").notNull(),
    billingPeriod: text("billing_period", { enum: ["monthly", "annual", "weekly", "other"] }).notNull().default("monthly"),
    priceMicros: integer("price_micros"),
    currency: text("currency").notNull().default("USD"),
    officialUrl: text("official_url").notNull(),
    termsVersion: text("terms_version"),
    termsLastVerifiedAt: integer("terms_last_verified_at"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("subscription_plan_slug_unique").on(table.slug),
    index("subscription_plan_active_provider_idx").on(table.isActive, table.providerName, table.name)
  ]
);

/** A user's private instance of a coding subscription configured in the CLI. */
export const userSubscription = sqliteTable(
  "user_subscription",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    planId: text("plan_id").references(() => subscriptionPlan.id, { onDelete: "set null" }),
    clientSubscriptionId: text("client_subscription_id").notNull(),
    providerName: text("provider_name").notNull(),
    planLabel: text("plan_label").notNull(),
    billingPeriod: text("billing_period", { enum: ["monthly", "annual", "weekly", "other"] }).notNull().default("monthly"),
    priceMicros: integer("price_micros"),
    currency: text("currency").notNull().default("USD"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    aggregateConsent: integer("aggregate_consent", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("user_subscription_client_unique").on(table.userId, table.clientSubscriptionId),
    index("user_subscription_plan_consent_idx").on(table.planId, table.aggregateConsent, table.endedAt),
    index("user_subscription_user_active_idx").on(table.userId, table.endedAt)
  ]
);

/**
 * Immutable, prompt-free token evidence. One row is the smallest reliable
 * native unit exposed by a harness: request, message, turn, or model/session
 * total. Model or effort changes therefore create new rows inside a session.
 */
export const usageSlice = sqliteTable(
  "usage_slice",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull().references(() => cliInstallation.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").notNull().references(() => userSubscription.id, { onDelete: "cascade" }),
    clientEventId: text("client_event_id").notNull(),
    tool: text("tool").notNull(),
    providerName: text("provider_name").notNull(),
    sessionHash: text("session_hash"),
    requestHash: text("request_hash"),
    requestedModel: text("requested_model"),
    reportedModel: text("reported_model").notNull(),
    modelFamily: text("model_family"),
    modelVersion: text("model_version"),
    reasoningEffort: text("reasoning_effort"),
    modelVariant: text("model_variant"),
    serviceTier: text("service_tier"),
    querySource: text("query_source", { enum: ["main", "subagent", "auxiliary", "background", "unknown"] }).notNull().default("unknown"),
    granularity: text("granularity", { enum: ["request", "message", "turn", "session_model"] }).notNull(),
    attributionQuality: text("attribution_quality", { enum: ["exact", "inferred", "estimated", "unknown"] }).notNull(),
    tokenAttributionQuality: text("token_attribution_quality", { enum: ["exact", "inferred", "estimated", "unknown"] }).notNull(),
    modelAttributionQuality: text("model_attribution_quality", { enum: ["exact", "inferred", "estimated", "unknown"] }).notNull(),
    effortAttributionQuality: text("effort_attribution_quality", { enum: ["exact", "inferred", "estimated", "unknown"] }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    reportedTotalTokens: integer("reported_total_tokens"),
    observedAt: integer("observed_at").notNull(),
    collectorVersion: text("collector_version").notNull(),
    ingestedAt: integer("ingested_at").notNull()
  },
  (table) => [
    uniqueIndex("usage_slice_installation_event_unique").on(table.installationId, table.clientEventId),
    uniqueIndex("usage_slice_installation_request_unique").on(table.installationId, table.requestHash),
    index("usage_slice_subscription_observed_idx").on(table.subscriptionId, table.observedAt),
    index("usage_slice_plan_dimensions_idx").on(table.providerName, table.reportedModel, table.reasoningEffort, table.observedAt),
    index("usage_slice_user_observed_idx").on(table.userId, table.observedAt),
    check("usage_slice_token_nonnegative", sql`${table.inputTokens} >= 0 and ${table.cacheReadTokens} >= 0 and ${table.cacheWriteTokens} >= 0 and ${table.outputTokens} >= 0 and ${table.reasoningTokens} >= 0`),
    check("usage_slice_has_tokens", sql`${table.inputTokens} + ${table.cacheReadTokens} + ${table.cacheWriteTokens} + ${table.outputTokens} + ${table.reasoningTokens} > 0`)
  ]
);

/** Provider-reported subscription quota state, kept separate from token facts. */
export const quotaSnapshot = sqliteTable(
  "quota_snapshot",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => authUser.id, { onDelete: "cascade" }),
    installationId: text("installation_id").notNull().references(() => cliInstallation.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").notNull().references(() => userSubscription.id, { onDelete: "cascade" }),
    clientEventId: text("client_event_id").notNull(),
    quotaScope: text("quota_scope").notNull(),
    windowKind: text("window_kind", { enum: ["session", "daily", "weekly", "monthly", "rolling", "unknown"] }).notNull(),
    usedPercent: real("used_percent"),
    remainingPercent: real("remaining_percent"),
    resetAt: integer("reset_at"),
    attributionQuality: text("attribution_quality", { enum: ["exact", "inferred", "estimated", "unknown"] }).notNull(),
    observedAt: integer("observed_at").notNull(),
    collectorVersion: text("collector_version").notNull(),
    ingestedAt: integer("ingested_at").notNull()
  },
  (table) => [
    uniqueIndex("quota_snapshot_installation_event_unique").on(table.installationId, table.clientEventId),
    uniqueIndex("quota_snapshot_installation_observation_unique").on(table.installationId, table.subscriptionId, table.quotaScope, table.observedAt),
    index("quota_snapshot_subscription_scope_observed_idx").on(table.subscriptionId, table.quotaScope, table.observedAt),
    check("quota_snapshot_used_range", sql`${table.usedPercent} is null or (${table.usedPercent} >= 0 and ${table.usedPercent} <= 100)`),
    check("quota_snapshot_remaining_range", sql`${table.remainingPercent} is null or (${table.remainingPercent} >= 0 and ${table.remainingPercent} <= 100)`)
  ]
);

/** Time-versioned public API prices used only for an explainable equivalent-value estimate. */
export const modelPrice = sqliteTable(
  "model_price",
  {
    id: text("id").primaryKey(),
    providerName: text("provider_name").notNull(),
    modelKey: text("model_key").notNull(),
    displayName: text("display_name").notNull(),
    inputMicrosPerMillion: integer("input_micros_per_million").notNull(),
    cacheReadMicrosPerMillion: integer("cache_read_micros_per_million").notNull(),
    cacheWriteMicrosPerMillion: integer("cache_write_micros_per_million").notNull(),
    outputMicrosPerMillion: integer("output_micros_per_million").notNull(),
    reasoningMicrosPerMillion: integer("reasoning_micros_per_million").notNull(),
    sourceUrl: text("source_url").notNull(),
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    uniqueIndex("model_price_provider_model_effective_unique").on(table.providerName, table.modelKey, table.effectiveFrom),
    index("model_price_lookup_idx").on(table.providerName, table.modelKey, table.effectiveFrom, table.effectiveTo)
  ]
);

/** Daily public-plan snapshot built only from opted-in, eligible telemetry. */
export const subscriptionAggregate = sqliteTable(
  "subscription_aggregate",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => subscriptionPlan.id, { onDelete: "cascade" }),
    period: text("period", { enum: ["7d", "30d", "90d"] }).notNull(),
    periodStart: integer("period_start").notNull(),
    periodEnd: integer("period_end").notNull(),
    contributorCount: integer("contributor_count").notNull(),
    subscriptionCount: integer("subscription_count").notNull(),
    usageSliceCount: integer("usage_slice_count").notNull(),
    exactSliceCount: integer("exact_slice_count").notNull(),
    completeWindowCount: integer("complete_window_count").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").notNull(),
    observedTokenTotal: integer("observed_token_total").notNull(),
    medianTokensPerSubscription: integer("median_tokens_per_subscription"),
    apiEquivalentMicros: integer("api_equivalent_micros"),
    allowanceValueScore: real("allowance_value_score"),
    satisfactionScore: real("satisfaction_score"),
    satisfactionCount: integer("satisfaction_count").notNull().default(0),
    qualityAdjustedValueScore: real("quality_adjusted_value_score"),
    confidence: real("confidence").notNull(),
    changePercent: real("change_percent"),
    methodologyVersion: text("methodology_version").notNull(),
    snapshotDay: integer("snapshot_day").notNull(),
    calculatedAt: integer("calculated_at").notNull()
  },
  (table) => [
    uniqueIndex("subscription_aggregate_plan_period_day_unique").on(table.planId, table.period, table.snapshotDay),
    index("subscription_aggregate_period_calculated_idx").on(table.period, table.calculatedAt, table.planId)
  ]
);

export const subscriptionDimensionAggregate = sqliteTable(
  "subscription_dimension_aggregate",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull().references(() => subscriptionPlan.id, { onDelete: "cascade" }),
    period: text("period", { enum: ["7d", "30d", "90d"] }).notNull(),
    reportedModel: text("reported_model").notNull(),
    reasoningEffort: text("reasoning_effort").notNull(),
    querySource: text("query_source").notNull(),
    contributorCount: integer("contributor_count").notNull(),
    usageSliceCount: integer("usage_slice_count").notNull(),
    exactSliceCount: integer("exact_slice_count").notNull(),
    observedTokenTotal: integer("observed_token_total").notNull(),
    apiEquivalentMicros: integer("api_equivalent_micros"),
    snapshotDay: integer("snapshot_day").notNull(),
    calculatedAt: integer("calculated_at").notNull()
  },
  (table) => [
    uniqueIndex("subscription_dimension_plan_period_key_day_unique").on(table.planId, table.period, table.reportedModel, table.reasoningEffort, table.querySource, table.snapshotDay),
    index("subscription_dimension_period_day_idx").on(table.period, table.snapshotDay, table.planId)
  ]
);

export const aggregate = sqliteTable(
  "aggregate",
  {
    id: text("id").primaryKey(),
    trackedItemId: text("tracked_item_id").notNull().references(() => trackedItem.id, { onDelete: "cascade" }),
    period: text("period", { enum: ["live", "24h", "7d", "release_baseline"] }).notNull(),
    periodStart: integer("period_start").notNull(),
    periodEnd: integer("period_end").notNull(),
    reportCount: integer("report_count").notNull(),
    weightedReportCount: real("weighted_report_count").notNull(),
    overallScore: real("overall_score").notNull(),
    resultQualityScore: real("result_quality_score").notNull(),
    usageEfficiencyScore: real("usage_efficiency_score").notNull(),
    confidence: real("confidence").notNull(),
    change: real("change").notNull(),
    state: text("state", { enum: ["new", "steady", "improving", "degrading"] }).notNull(),
    /** UTC day bucket; cron updates one row per model/period/day. */
    snapshotDay: integer("snapshot_day").notNull(),
    calculatedAt: integer("calculated_at").notNull()
  },
  (table) => [
    uniqueIndex("aggregate_item_period_day_unique").on(table.trackedItemId, table.period, table.snapshotDay),
    index("aggregate_item_period_calculated_idx").on(table.trackedItemId, table.period, table.calculatedAt),
    index("aggregate_item_period_end_idx").on(table.trackedItemId, table.period, table.periodEnd),
    index("aggregate_period_calculated_item_idx").on(table.period, table.calculatedAt, table.trackedItemId)
  ]
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
  updatedBy: text("updated_by").references(() => authUser.id, { onDelete: "set null" })
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").references(() => authUser.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    createdAt: integer("created_at").notNull()
  },
  (table) => [index("audit_log_entity_idx").on(table.entityType, table.entityId, table.createdAt)]
);

export const riskEvent = sqliteTable(
  "risk_event",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => authUser.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    score: real("score").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [index("risk_event_expiry_idx").on(table.expiresAt), index("risk_event_user_idx").on(table.userId, table.createdAt)]
);

export const aggregationJobLock = sqliteTable("aggregation_job_lock", {
  key: text("key").primaryKey(),
  lockedUntil: integer("locked_until").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const schema = {
  authUser,
  authSession,
  authAccount,
  authVerification,
  trackedItem,
  catalogCandidate,
  userProfile,
  deletedIdentity,
  feedbackReport,
  cliDeviceAuthorization,
  cliInstallation,
  cliTurnstileChallenge,
  modelAlias,
  feedbackContext,
  subscriptionPlan,
  userSubscription,
  usageSlice,
  quotaSnapshot,
  modelPrice,
  subscriptionAggregate,
  subscriptionDimensionAggregate,
  aggregate,
  settings,
  auditLog,
  riskEvent,
  aggregationJobLock
};
