import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { allowanceCommandSchema, type AllowanceCommand } from "../lib/feedback";
import type { FeedbackAllowance as FeedbackAllowanceState } from "../types";

const WINDOW_MS = 24 * 60 * 60_000;

interface AllowanceOutcome {
  accepted: boolean;
  idempotent: boolean;
  code?: "allowance_exhausted" | "item_already_rated" | "session_already_rated";
  reportId?: string;
  allowance: FeedbackAllowanceState;
}

const json = (body: AllowanceOutcome, status = 200) => Response.json(body, { status, headers: { "content-type": "application/json" } });

/**
 * One instance is addressed by internal user ID. It has no permanent feedback
 * state: D1 remains authoritative. A narrow promise queue serializes only
 * submissions for this user without blocking the entire object across D1 I/O.
 */
export class FeedbackAllowance extends DurableObject<Env> {
  private submissionQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, private readonly bindings: Env) {
    super(state, bindings);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    const parsed = allowanceCommandSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Invalid allowance command", { status: 400 });
    const submission = this.submissionQueue.then(() => this.submit(parsed.data));
    this.submissionQueue = submission.then(() => undefined, () => undefined);
    return submission;
  }

  private async allowanceFor(userId: string, now: number): Promise<FeedbackAllowanceState> {
    const since = now - WINDOW_MS;
    const result = await this.bindings.DB.prepare(
      `select tracked_item_id, submitted_at from feedback_report
       where user_id = ? and submitted_at >= ? order by submitted_at asc`
    ).bind(userId, since).all<{ tracked_item_id: string; submitted_at: number }>();
    const reports = result.results;
    return {
      remaining: Math.max(0, 2 - reports.length) as FeedbackAllowanceState["remaining"],
      nextAvailableAt: reports.length >= 2 ? new Date(reports[0]!.submitted_at + WINDOW_MS).toISOString() : null,
      alreadyRatedItemIds: [...new Set(reports.map((report) => report.tracked_item_id))]
    };
  }

  private async submit(command: AllowanceCommand): Promise<Response> {
    const { userId, now, report } = command;
    const existing = await this.bindings.DB.prepare(
      "select id from feedback_report where user_id = ? and idempotency_key = ? limit 1"
    ).bind(userId, report.idempotencyKey).first<{ id: string }>();
    if (existing) {
      return json({ accepted: true, idempotent: true, reportId: existing.id, allowance: await this.allowanceFor(userId, now) });
    }

    if (command.cliContext) {
      const priorSession = await this.bindings.DB.prepare(
        `select fr.id from feedback_context fc
         join feedback_report fr on fr.feedback_context_id = fc.id
         where fc.installation_id = ? and fc.session_hash = ? limit 1`
      ).bind(command.cliContext.installationId, command.cliContext.sessionHash).first<{ id: string }>();
      if (priorSession) {
        return json({
          accepted: false,
          idempotent: false,
          code: "session_already_rated",
          reportId: priorSession.id,
          allowance: await this.allowanceFor(userId, now)
        }, 409);
      }
    }

    const allowance = await this.allowanceFor(userId, now);
    if (allowance.alreadyRatedItemIds.includes(report.trackedItemId)) {
      return json({ accepted: false, idempotent: false, code: "item_already_rated", allowance }, 409);
    }
    if (allowance.remaining === 0) {
      return json({ accepted: false, idempotent: false, code: "allowance_exhausted", allowance }, 429);
    }

    const reportId = crypto.randomUUID();
    const contextId = command.cliContext ? crypto.randomUUID() : null;
    try {
      const reportInsert = this.bindings.DB.prepare(
        `insert into feedback_report (
          id, user_id, tracked_item_id, agent_item_id, result_quality_rating, usage_efficiency_rating,
          tags_json, short_comment, effective_weight, moderation_status, fraud_risk_score,
          included_in_scores, duplicate_cluster_adjustment, ip_hash, device_hash, idempotency_key,
          source, feedback_context_id, client_event_id, submitted_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        reportId,
        userId,
        report.trackedItemId,
        report.agentItemId ?? null,
        report.resultQualityRating,
        report.usageEfficiencyRating,
        JSON.stringify(report.tags),
        report.shortComment ?? null,
        command.effectiveWeight,
        command.fraudRiskScore,
        command.duplicateClusterAdjustment,
        command.ipHash,
        command.deviceHash,
        report.idempotencyKey,
        command.cliContext ? "cli" : "web",
        contextId,
        command.cliContext?.clientEventId ?? null,
        now,
        now,
        now
      );
      if (command.cliContext && contextId) {
        await this.bindings.DB.batch([
          this.bindings.DB.prepare(
            `insert into feedback_context (
              id, user_id, installation_id, tracked_item_id, session_hash, tool, raw_model_label,
              attribution, adapter_version, session_duration_bucket, created_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            contextId,
            userId,
            command.cliContext.installationId,
            report.trackedItemId,
            command.cliContext.sessionHash,
            command.cliContext.tool,
            command.cliContext.rawModelLabel,
            command.cliContext.attribution,
            command.cliContext.adapterVersion,
            command.cliContext.sessionDurationBucket,
            now
          ),
          reportInsert
        ]);
      } else {
        await reportInsert.run();
      }
    } catch (error) {
      // A unique idempotency collision after an isolate restart is safely replayed.
      const replay = await this.bindings.DB.prepare(
        "select id from feedback_report where user_id = ? and idempotency_key = ? limit 1"
      ).bind(userId, report.idempotencyKey).first<{ id: string }>();
      if (replay) return json({ accepted: true, idempotent: true, reportId: replay.id, allowance: await this.allowanceFor(userId, now) });
      throw error;
    }

    return json({ accepted: true, idempotent: false, reportId, allowance: await this.allowanceFor(userId, now) }, 201);
  }
}
