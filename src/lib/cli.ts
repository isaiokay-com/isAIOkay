import { z } from "zod";

export const cliToolSchema = z.enum([
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "gemini-cli",
  "copilot-cli",
  "aider",
  "windsurf",
  "cline",
  "amp",
  "grok-build",
  "qwen-code",
  "kimi-code",
  "muse-code",
  "other"
]);

export type CliTool = z.infer<typeof cliToolSchema>;

export const attributionSchema = z.enum([
  "verified_active",
  "verified_start_only",
  "model_at_end",
  "user_confirmed",
  "mixed",
  "opaque_router",
  "unknown"
]);

export const sessionDurationBucketSchema = z.enum([
  "under_10m",
  "10_30m",
  "30_60m",
  "over_60m",
  "unknown"
]);

export const deviceStartSchema = z.object({
  clientName: z.string().trim().min(1).max(80).default("IsAIokay.com CLI")
}).strict();

export const deviceTokenSchema = z.object({
  deviceCode: z.string().min(32).max(256)
}).strict();

export const deviceApprovalSchema = z.object({
  userCode: z.string().trim().min(4).max(16)
}).strict();

export const cliChallengeIdSchema = z.uuid();

export const cliChallengeVerificationSchema = z.object({
  turnstileToken: z.string().min(1).max(4096).optional()
}).strict();

export const cliFeedbackInputSchema = z.object({
  tool: cliToolSchema,
  rawModelLabel: z.string().trim().min(1).max(160).optional(),
  confirmedItemSlug: z.string().trim().min(1).max(100).optional(),
  attribution: attributionSchema,
  adapterVersion: z.string().trim().min(1).max(32),
  sessionHash: z.string().regex(/^(?:[a-f0-9]{64}|[A-Za-z0-9_-]{43})$/i),
  sessionDurationBucket: sessionDurationBucketSchema.default("unknown"),
  resultQualityRating: z.number().int().min(1).max(5),
  usageEfficiencyRating: z.number().int().min(1).max(5),
  tags: z.array(z.string().trim().min(1).max(32)).max(6).default([]),
  shortComment: z.string().trim().max(500).optional(),
  clientEventId: z.uuid(),
  challengeId: cliChallengeIdSchema.optional(),
  challengeProof: z.string().regex(/^[a-f0-9]{64}$/i).optional()
}).strict().superRefine((value, context) => {
  if (Boolean(value.challengeId) === Boolean(value.challengeProof)) return;
  context.addIssue({
    code: "custom",
    path: [value.challengeId ? "challengeProof" : "challengeId"],
    message: "A CLI browser verification challenge and proof must be supplied together."
  });
});

export type CliFeedbackInput = z.infer<typeof cliFeedbackInputSchema>;

export const normalizeModelLabel = (value: string): string => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 160);

export const toolFallbackSlug = (tool: CliTool): string | null => ({
  codex: "codex",
  "claude-code": "claude-code",
  cursor: "cursor",
  opencode: "opencode",
  "gemini-cli": "gemini-cli",
  "copilot-cli": "github-copilot-cli",
  aider: "aider",
  windsurf: "windsurf",
  cline: "cline",
  amp: "amp",
  "grok-build": "grok-build",
  "qwen-code": "qwen-code",
  "kimi-code": "kimi-code",
  "muse-code": "muse-code",
  other: null
})[tool];
