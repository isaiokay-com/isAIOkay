import { describe, expect, it } from "vitest";
import { cliFeedbackInputSchema } from "../../src/lib/cli";
import { feedbackEditInputSchema, feedbackInputSchema } from "../../src/lib/feedback";

const sharedAnswers = {
  resultQualityRating: 2,
  usageEfficiencyRating: 3,
  tags: ["regression"],
  shortComment: "The result needed substantial rework."
} as const;

describe("shared feedback questionnaire", () => {
  it("accepts the same two person-supplied measurements used by the CLI", () => {
    expect(feedbackInputSchema.parse({
      ...sharedAnswers,
      trackedItemId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID()
    })).toMatchObject(sharedAnswers);
    expect(cliFeedbackInputSchema.parse({
      ...sharedAnswers,
      tool: "codex",
      rawModelLabel: "gpt-5.6-sol",
      attribution: "verified_active",
      adapterVersion: "0.2.1",
      sessionHash: "a".repeat(64),
      sessionDurationBucket: "10_30m",
      clientEventId: crypto.randomUUID()
    })).toMatchObject(sharedAnswers);
  });

  it("validates one-time web edit answers without allowing the model to change", () => {
    const parsed = feedbackEditInputSchema.parse({
      reportId: crypto.randomUUID(),
      resultQualityRating: 5,
      usageEfficiencyRating: 4,
      tags: ["corrected"]
    });
    expect(parsed.resultQualityRating).toBe(5);
    expect(feedbackEditInputSchema.safeParse({ ...parsed, trackedItemId: crypto.randomUUID() }).success).toBe(false);
  });

  it("rejects removed questionnaire fields instead of retaining a legacy contract", () => {
    expect(feedbackInputSchema.safeParse({
      ...sharedAnswers,
      trackedItemId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      comparison: "worse"
    }).success).toBe(false);
  });
});
