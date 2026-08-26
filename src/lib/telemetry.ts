import { z } from "zod";
import { cliToolSchema } from "./cli";

const safeLabel = (maximum: number) => z.string().trim().min(1).max(maximum)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/ +()@-]*$/, "Contains unsupported characters.");
const optionalLabel = (maximum: number) => safeLabel(maximum).optional();
const tokenCount = z.number().int().min(0).max(1_000_000_000_000);
const timestamp = z.number().int().min(1);
const privateHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const billingPeriodSchema = z.enum(["monthly", "annual", "weekly", "other"]);
export const attributionQualitySchema = z.enum(["exact", "inferred", "estimated", "unknown"]);
export const usageGranularitySchema = z.enum(["request", "message", "turn", "session_model"]);
export const querySourceSchema = z.enum(["main", "subagent", "auxiliary", "background", "unknown"]);
export const quotaWindowKindSchema = z.enum(["session", "daily", "weekly", "monthly", "rolling", "unknown"]);

export const subscriptionInputSchema = z.object({
  clientSubscriptionId: z.uuid(),
  providerName: safeLabel(80),
  planLabel: safeLabel(100),
  planSlug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  billingPeriod: billingPeriodSchema.default("monthly"),
  priceMicros: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("USD"),
  startedAt: timestamp.nullable().optional(),
  endedAt: timestamp.nullable().optional(),
  aggregateConsent: z.boolean().default(false)
}).strict().superRefine((value, context) => {
  if (value.startedAt && value.endedAt && value.endedAt <= value.startedAt) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt must be after startedAt." });
  }
});

export const usageSliceInputSchema = z.object({
  clientEventId: z.uuid(),
  clientSubscriptionId: z.uuid(),
  tool: cliToolSchema,
  sessionHash: privateHash.nullable().optional(),
  requestHash: privateHash.nullable().optional(),
  requestedModel: optionalLabel(160).nullable().optional(),
  reportedModel: safeLabel(160),
  modelFamily: optionalLabel(80).nullable().optional(),
  modelVersion: optionalLabel(80).nullable().optional(),
  reasoningEffort: optionalLabel(32).nullable().optional(),
  modelVariant: optionalLabel(80).nullable().optional(),
  serviceTier: optionalLabel(40).nullable().optional(),
  querySource: querySourceSchema.default("unknown"),
  granularity: usageGranularitySchema,
  attributionQuality: attributionQualitySchema,
  tokenAttributionQuality: attributionQualitySchema.optional(),
  modelAttributionQuality: attributionQualitySchema.optional(),
  effortAttributionQuality: attributionQualitySchema.optional(),
  inputTokens: tokenCount.default(0),
  cacheReadTokens: tokenCount.default(0),
  cacheWriteTokens: tokenCount.default(0),
  outputTokens: tokenCount.default(0),
  reasoningTokens: tokenCount.default(0),
  reportedTotalTokens: tokenCount.nullable().optional(),
  observedAt: timestamp,
  collectorVersion: safeLabel(32)
}).strict().superRefine((value, context) => {
  const total = value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens + value.reasoningTokens;
  if (total <= 0) context.addIssue({ code: "custom", path: ["inputTokens"], message: "A usage slice must contain tokens." });
});

export const quotaSnapshotInputSchema = z.object({
  clientEventId: z.uuid(),
  clientSubscriptionId: z.uuid(),
  quotaScope: safeLabel(80),
  windowKind: quotaWindowKindSchema,
  usedPercent: z.number().min(0).max(100).nullable().optional(),
  remainingPercent: z.number().min(0).max(100).nullable().optional(),
  resetAt: timestamp.nullable().optional(),
  attributionQuality: attributionQualitySchema,
  observedAt: timestamp,
  collectorVersion: safeLabel(32)
}).strict().superRefine((value, context) => {
  if (value.usedPercent == null && value.remainingPercent == null) {
    context.addIssue({ code: "custom", path: ["usedPercent"], message: "A quota snapshot needs usedPercent or remainingPercent." });
  }
});

export const telemetryBatchSchema = z.object({
  usage: z.array(usageSliceInputSchema).max(100).default([]),
  quota: z.array(quotaSnapshotInputSchema).max(100).default([])
}).strict().superRefine((value, context) => {
  if (value.usage.length + value.quota.length === 0) {
    context.addIssue({ code: "custom", path: ["usage"], message: "The telemetry batch is empty." });
  }
  if (value.usage.length + value.quota.length > 100) {
    context.addIssue({ code: "custom", path: ["usage"], message: "A telemetry batch may contain at most 100 observations." });
  }
});

export const telemetryDeleteSchema = z.object({
  includeSubscriptions: z.boolean().default(false)
}).strict();

export type SubscriptionInput = z.infer<typeof subscriptionInputSchema>;
export type UsageSliceInput = z.infer<typeof usageSliceInputSchema>;
export type QuotaSnapshotInput = z.infer<typeof quotaSnapshotInputSchema>;
export type TelemetryBatch = z.infer<typeof telemetryBatchSchema>;

export const validateObservationTime = (observedAt: number, now: number): boolean =>
  observedAt <= now + 5 * 60_000 && observedAt >= now - 366 * 24 * 60 * 60_000;
