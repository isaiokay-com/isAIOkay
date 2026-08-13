import { z } from "zod";

export const FEEDBACK_EDIT_WINDOW_MS = 10 * 60_000;

const feedbackAnswersSchema = z.object({
  resultQualityRating: z.number().int().min(1).max(5),
  usageEfficiencyRating: z.number().int().min(1).max(5),
  tags: z.array(z.string().trim().min(1).max(32)).max(6).default([]),
  shortComment: z.string().trim().max(500).optional()
});

export const feedbackInputSchema = z.object({
  trackedItemId: z.uuid(),
  agentItemId: z.uuid().nullable().optional(),
  ...feedbackAnswersSchema.shape,
  idempotencyKey: z.uuid(),
  turnstileToken: z.string().min(1).max(4096).optional(),
  deviceId: z.string().min(8).max(256).optional()
}).strict();

export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

export const feedbackEditInputSchema = z.object({
  reportId: z.uuid(),
  agentItemId: z.uuid().nullable().optional(),
  ...feedbackAnswersSchema.shape
}).strict();

export type FeedbackEditInput = z.infer<typeof feedbackEditInputSchema>;

const feedbackReportSchema = feedbackInputSchema.omit({ turnstileToken: true, deviceId: true });

export const allowanceCommandSchema = z.object({
  userId: z.uuid(),
  now: z.number().int().positive(),
  report: feedbackReportSchema,
  effectiveWeight: z.number().min(0).max(1),
  fraudRiskScore: z.number().min(0).max(1),
  duplicateClusterAdjustment: z.number().min(0).max(1),
  ipHash: z.string().max(128).nullable(),
  deviceHash: z.string().max(128).nullable(),
  cliContext: z.object({
    installationId: z.uuid(),
    sessionHash: z.string().regex(/^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/i),
    tool: z.string().min(1).max(40),
    rawModelLabel: z.string().max(160).nullable(),
    attribution: z.enum(["verified_active", "verified_start_only", "model_at_end", "user_confirmed", "mixed", "opaque_router", "unknown"]),
    adapterVersion: z.string().min(1).max(32),
    sessionDurationBucket: z.enum(["under_10m", "10_30m", "30_60m", "over_60m", "unknown"]),
    clientEventId: z.uuid()
  }).strict().optional()
}).strict();

export type AllowanceCommand = z.infer<typeof allowanceCommandSchema>;

export const feedbackEditCommandSchema = z.object({
  userId: z.uuid(),
  now: z.number().int().positive(),
  report: feedbackEditInputSchema
}).strict();

export type FeedbackEditCommand = z.infer<typeof feedbackEditCommandSchema>;

export const accountDeletionCommandSchema = z.object({
  userId: z.uuid(),
  now: z.number().int().positive()
}).strict();

export type AccountDeletionCommand = z.infer<typeof accountDeletionCommandSchema>;
