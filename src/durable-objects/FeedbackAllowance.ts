import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { deleteOwnAccount, hasDeletedGitHubIdentity } from "../db/repositories";
import { accountDeletionCommandSchema, allowanceCommandSchema, feedbackEditCommandSchema, FEEDBACK_EDIT_WINDOW_MS, type AccountDeletionCommand, type AllowanceCommand, type FeedbackEditCommand } from "../lib/feedback";
import type { FeedbackAllowance as FeedbackAllowanceState } from "../types";
import { isConfiguredAdministratorGitHubId } from "../lib/administration";

const WINDOW_MS = 24 * 60 * 60_000;

interface AllowanceOutcome {
  accepted: boolean;
  idempotent: boolean;
  code?: "account_unavailable" | "allowance_exhausted" | "item_already_rated" | "session_already_rated";
  reportId?: string;
  allowance: FeedbackAllowanceState;
}

interface EditOutcome {
  edited: boolean;
  code?: "account_unavailable" | "edit_not_latest" | "edit_expired" | "edit_already_used";
  reportId?: string;
  allowance: FeedbackAllowanceState;
}

interface DeletionOutcome {
  deleted: boolean;
  code?: "account_unavailable" | "administrator_deletion_blocked";
  previousUsername?: string;
}

const json = (body: AllowanceOutcome | EditOutcome | DeletionOutcome, status = 200) => Response.json(body, { status, headers: { "content-type": "application/json" } });

/**
 * One instance is addressed by internal user ID. It has no permanent feedback
 * state: D1 remains authoritative. A narrow promise queue serializes report
 * commands and account deletion for this user across D1 I/O.
 */
export class FeedbackAllowance extends DurableObject<Env> {
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, private readonly bindings: Env) {
    super(state, bindings);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/submit" && pathname !== "/edit" && pathname !== "/delete") return new Response("Not found", { status: 404 });
    const isEdit = pathname === "/edit";
    const isDelete = pathname === "/delete";
    const schema = isDelete ? accountDeletionCommandSchema : isEdit ? feedbackEditCommandSchema : allowanceCommandSchema;
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response("Invalid allowance command", { status: 400 });
    const command = this.commandQueue.then(() => isDelete
      ? this.deleteAccount(parsed.data as AccountDeletionCommand)
      : isEdit
        ? this.edit(parsed.data as FeedbackEditCommand)
        : this.submit(parsed.data as AllowanceCommand));
    this.commandQueue = command.then(() => undefined, () => undefined);
    return command;
  }

  private async isAccountAvailable(userId: string): Promise<boolean> {
    const profile = await this.bindings.DB.prepare(
      "select github_user_id, status from user_profile where user_id = ? limit 1"
    ).bind(userId).first<{ github_user_id: string; status: string }>();
    if (!profile || (profile.status !== "active" && profile.status !== "admin")) return false;
    return !(await hasDeletedGitHubIdentity(this.bindings, profile.github_user_id));
  }

  private async deleteAccount(command: AccountDeletionCommand): Promise<Response> {
    const profile = await this.bindings.DB.prepare(
      "select github_user_id, status from user_profile where user_id = ? limit 1"
    ).bind(command.userId).first<{ github_user_id: string; status: string }>();
    if (!profile || profile.status === "deleted") {
      return json({ deleted: false, code: "account_unavailable" }, 409);
    }
    if (profile.status === "admin" || isConfiguredAdministratorGitHubId(this.bindings, profile.github_user_id)) {
      return json({ deleted: false, code: "administrator_deletion_blocked" }, 409);
    }
    const { previousUsername } = await deleteOwnAccount(this.bindings, command.userId, command.now);
    return json({ deleted: true, previousUsername });
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
    if (!(await this.isAccountAvailable(userId))) {
      return json({ accepted: false, idempotent: false, code: "account_unavailable", allowance: await this.allowanceFor(userId, now) }, 403);
    }
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

  private async edit(command: FeedbackEditCommand): Promise<Response> {
    const { userId, now, report } = command;
    if (!(await this.isAccountAvailable(userId))) {
      return json({ edited: false, code: "account_unavailable", allowance: await this.allowanceFor(userId, now) }, 403);
    }
    const latest = await this.bindings.DB.prepare(
      `select id, submitted_at, edited_at, agent_item_id, result_quality_rating,
         usage_efficiency_rating, tags_json, short_comment
       from feedback_report where user_id = ?
       order by submitted_at desc, created_at desc, id desc limit 1`
    ).bind(userId).first<{
      id: string;
      submitted_at: number;
      edited_at: number | null;
      agent_item_id: string | null;
      result_quality_rating: number;
      usage_efficiency_rating: number;
      tags_json: string;
      short_comment: string | null;
    }>();
    const allowance = async () => this.allowanceFor(userId, now);
    if (!latest || latest.id !== report.reportId) {
      return json({ edited: false, code: "edit_not_latest", allowance: await allowance() }, 409);
    }
    if (latest.edited_at !== null) {
      return json({ edited: false, code: "edit_already_used", allowance: await allowance() }, 409);
    }
    if (now >= latest.submitted_at + FEEDBACK_EDIT_WINDOW_MS) {
      return json({ edited: false, code: "edit_expired", allowance: await allowance() }, 410);
    }

    const before = {
      agentItemId: latest.agent_item_id,
      resultQualityRating: latest.result_quality_rating,
      usageEfficiencyRating: latest.usage_efficiency_rating,
      tagsJson: latest.tags_json,
      shortComment: latest.short_comment
    };
    const after = {
      agentItemId: report.agentItemId ?? null,
      resultQualityRating: report.resultQualityRating,
      usageEfficiencyRating: report.usageEfficiencyRating,
      tagsJson: JSON.stringify(report.tags),
      shortComment: report.shortComment ?? null
    };
    const [updated] = await this.bindings.DB.batch([
      this.bindings.DB.prepare(
        `update feedback_report set agent_item_id = ?, result_quality_rating = ?, usage_efficiency_rating = ?,
           tags_json = ?, short_comment = ?, edited_at = ?, updated_at = ?
         where id = ? and user_id = ? and edited_at is null`
      ).bind(
        after.agentItemId,
        after.resultQualityRating,
        after.usageEfficiencyRating,
        after.tagsJson,
        after.shortComment,
        now,
        now,
        report.reportId,
        userId
      ),
      this.bindings.DB.prepare(
        `insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at)
         values (?, ?, 'edit_own_report', 'feedback_report', ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, report.reportId, JSON.stringify(before), JSON.stringify(after), now)
    ]);
    if ((updated?.meta.changes ?? 0) !== 1) {
      return json({ edited: false, code: "edit_already_used", allowance: await allowance() }, 409);
    }

    return json({ edited: true, reportId: report.reportId, allowance: await allowance() });
  }
}
