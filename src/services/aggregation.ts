import type { Env } from "../env";
import { allActiveItems, archiveExpiredRiskData, getReportsForAggregation, getSettings, latestAggregateBefore, saveAggregate, saveAggregates } from "../db/repositories";
import { regeneratePublicCache } from "../lib/cache";
import { aggregateState, calculateScores, isEligibleScoreReport, qualifiesReleaseBaseline } from "../lib/scoring";
import { cleanupCliTurnstileChallenges } from "./cli-turnstile";
import { runCatalogDiscovery } from "./catalog-discovery";
import type { Period } from "../types";

const PERIOD_LENGTH: Record<Exclude<Period, "live">, number> = { "24h": 86_400_000, "7d": 7 * 86_400_000 };

interface AggregationLease {
  acquiredAt: number;
  lockedUntil: number;
}

const acquireAggregationLock = async (env: Env, now: number): Promise<AggregationLease | null> => {
  const lockUntil = now + 14 * 60_000;
  await env.DB.prepare("insert into aggregation_job_lock (key, locked_until, updated_at) values ('aggregate', 0, 0) on conflict(key) do nothing").run();
  const result = await env.DB.prepare(
    "update aggregation_job_lock set locked_until = ?, updated_at = ? where key = 'aggregate' and locked_until <= ?"
  ).bind(lockUntil, now, now).run();
  return (result.meta.changes ?? 0) === 1 ? { acquiredAt: now, lockedUntil: lockUntil } : null;
};

const releaseAggregationLock = async (env: Env, lease: AggregationLease): Promise<void> => {
  await env.DB.prepare(
    "update aggregation_job_lock set locked_until = 0, updated_at = ? where key = 'aggregate' and locked_until = ? and updated_at = ?"
  ).bind(Date.now(), lease.lockedUntil, lease.acquiredAt).run();
};

const mapReport = (report: Awaited<ReturnType<typeof getReportsForAggregation>>[number]) => ({
  submittedAt: report.submitted_at,
  resultQualityRating: report.result_quality_rating,
  usageEfficiencyRating: report.usage_efficiency_rating,
  trustWeight: report.effective_weight,
  fraudRiskScore: report.fraud_risk_score,
  moderationStatus: report.moderation_status as "pending" | "approved" | "excluded",
  includedInScores: Boolean(report.included_in_scores),
  duplicateClusterAdjustment: report.duplicate_cluster_adjustment
});

export const recalculatePeriod = async (env: Env, period: Period, now: number): Promise<void> => {
  const settings = await getSettings(env);
  const periodLength = period === "live" ? settings.liveScoreLookbackDays * 86_400_000 : PERIOD_LENGTH[period];
  const periodStart = now - periodLength;
  const items = await allActiveItems(env);
  const snapshots: Parameters<typeof saveAggregates>[1] = [];
  for (const item of items) {
    const reports = await getReportsForAggregation(env, item.id, periodStart, now);
    const score = calculateScores(reports.map(mapReport), now, settings, period === "live"
      ? { recencyMode: "live", liveHalfLifeDays: settings.liveScoreHalfLifeDays }
      : undefined);
    const previous = await latestAggregateBefore(env, item.id, period, period === "live" ? now - 86_400_000 : periodStart);
    const change = previous ? score.overallScore - previous.overallScore : 0;
    snapshots.push({
      id: crypto.randomUUID(),
      trackedItemId: item.id,
      period,
      periodStart,
      periodEnd: now,
      reportCount: score.reportCount,
      weightedReportCount: score.weightedReportCount,
      overallScore: score.overallScore,
      resultQualityScore: score.resultQualityScore,
      usageEfficiencyScore: score.usageEfficiencyScore,
      confidence: score.confidence,
      change,
      state: aggregateState(change, score.reportCount, score.confidence, settings),
      snapshotDay: Math.floor(now / 86_400_000) * 86_400_000,
      calculatedAt: now
    });
  }
  await saveAggregates(env, snapshots);
};

export const lockReleaseBaselines = async (env: Env, now: number): Promise<void> => {
  const settings = await getSettings(env);
  const rows = await env.DB.prepare(
    `select id, release_at, baseline_start_at, baseline_end_at, baseline_locked_at
     from tracked_item where is_active = 1 and release_at is not null`
  ).all<{ id: string; release_at: number; baseline_start_at: number | null; baseline_end_at: number | null; baseline_locked_at: number | null }>();
  for (const item of rows.results) {
    const baselineStart = item.baseline_start_at ?? item.release_at + 48 * 60 * 60_000;
    const baselineEnd = item.baseline_end_at ?? baselineStart + 7 * 86_400_000;
    if (now < baselineEnd) {
      if (item.baseline_start_at === null || item.baseline_end_at === null) {
        await env.DB.prepare("update tracked_item set baseline_start_at = ?, baseline_end_at = ?, baseline_method_version = 'v1', updated_at = ? where id = ?")
          .bind(baselineStart, baselineEnd, now, item.id).run();
      }
      continue;
    }
    const existing = await env.DB.prepare(
      "select id from aggregate where tracked_item_id = ? and period = 'release_baseline' limit 1"
    ).bind(item.id).first<{ id: string }>();
    // A completed release baseline is historical evidence. Cron must never
    // rewrite or delete it because moderation or settings changed later;
    // replacement is an explicit audited administrator operation.
    if (existing) continue;
    const reports = await getReportsForAggregation(env, item.id, baselineStart, baselineEnd);
    const eligibleReports = reports.filter((report) => isEligibleScoreReport(mapReport(report)));
    const score = calculateScores(eligibleReports.map(mapReport), baselineEnd, settings);
    const uniqueReporters = new Set(eligibleReports.map((report) => report.user_id)).size;
    const submittedTimes = eligibleReports.map((report) => report.submitted_at);
    const spanDays = submittedTimes.length > 1
      ? (Math.max(...submittedTimes) - Math.min(...submittedTimes)) / 86_400_000
      : 0;
    const qualified = qualifiesReleaseBaseline({
      reportCount: score.reportCount,
      uniqueReporters,
      spanDays,
      confidence: score.confidence
    }, settings);
    if (!qualified) {
      // Keep the prospective window visible as insufficient evidence. Never
      // freeze the Bayesian prior as if it were observed release performance.
      await env.DB.prepare(
        "update tracked_item set baseline_start_at = ?, baseline_end_at = ?, baseline_method_version = 'v1', updated_at = ? where id = ?"
      ).bind(baselineStart, baselineEnd, now, item.id).run();
      continue;
    }
    await saveAggregate(env, {
      id: crypto.randomUUID(), trackedItemId: item.id, period: "release_baseline", periodStart: baselineStart, periodEnd: baselineEnd,
      reportCount: score.reportCount, weightedReportCount: score.weightedReportCount, overallScore: score.overallScore,
      resultQualityScore: score.resultQualityScore, usageEfficiencyScore: score.usageEfficiencyScore,
      confidence: score.confidence, change: 0, state: "new",
      snapshotDay: Math.floor(baselineEnd / 86_400_000) * 86_400_000, calculatedAt: now
    });
    await env.DB.batch([
      env.DB.prepare("update tracked_item set baseline_locked_at = ?, baseline_start_at = ?, baseline_end_at = ?, baseline_method_version = 'v1', updated_at = ? where id = ?")
        .bind(now, baselineStart, baselineEnd, now, item.id),
      env.DB.prepare("insert into audit_log (id, action, entity_type, entity_id, after_json, created_at) values (?, 'lock_release_baseline', 'tracked_item', ?, ?, ?)")
        .bind(crypto.randomUUID(), item.id, JSON.stringify({ baselineStart, baselineEnd, methodVersion: "v1" }), now)
    ]);
  }
};

export const reconcileVotingSpikes = async (env: Env, now: number): Promise<void> => {
  const shortWindow = now - 10 * 60_000;
  const [deviceRows, ipRows] = await Promise.all([
    env.DB.prepare(
      `select device_hash from feedback_report
       where submitted_at >= ? and device_hash is not null
       group by device_hash having count(distinct user_id) >= 3`
    ).bind(shortWindow).all<{ device_hash: string }>(),
    env.DB.prepare(
      `select ip_hash from feedback_report
       where submitted_at >= ? and ip_hash is not null
       group by ip_hash having count(distinct user_id) >= 5`
    ).bind(shortWindow).all<{ ip_hash: string }>()
  ]);
  if (deviceRows.results.length === 0 && ipRows.results.length === 0) return;

  // Per-user Durable Objects cannot serialize different users. Reconcile any
  // cross-user race here before aggregation so clustered reports are downweighted
  // even when their concurrent pre-insert checks all observed an empty cluster.
  const updates = [
    ...deviceRows.results.map((row) => env.DB.prepare(
      `update feedback_report
       set duplicate_cluster_adjustment = min(duplicate_cluster_adjustment, 0.4),
           fraud_risk_score = max(fraud_risk_score, 0.45),
           updated_at = ?
       where device_hash = ? and submitted_at >= ?`
    ).bind(now, row.device_hash, shortWindow)),
    ...ipRows.results.map((row) => env.DB.prepare(
      `update feedback_report
       set duplicate_cluster_adjustment = min(duplicate_cluster_adjustment, 0.5),
           fraud_risk_score = max(fraud_risk_score, 0.35),
           updated_at = ?
       where ip_hash = ? and submitted_at >= ?`
    ).bind(now, row.ip_hash, shortWindow))
  ];
  await env.DB.batch(updates);

  const userRows = await env.DB.prepare(
    `select distinct user_id from feedback_report
     where submitted_at >= ?
       and (duplicate_cluster_adjustment < 1 or fraud_risk_score >= 0.35)`
  ).bind(shortWindow).all<{ user_id: string }>();
  const userIds = userRows.results.map((row) => row.user_id);
  if (userIds.length === 0) return;
  const expiresAt = now + 24 * 60 * 60_000;
  await env.DB.batch(userIds.map((userId) => env.DB.prepare(
    "insert into risk_event (id, user_id, kind, score, expires_at, created_at) values (?, ?, 'velocity', 0.8, ?, ?)"
  ).bind(crypto.randomUUID(), userId, expiresAt, now)));
};

/** Idempotent cron work. The D1 compare-and-set lock prevents overlapping runs. */
export const runScheduledMaintenance = async (env: Env, now = Date.now()): Promise<{ ran: boolean; discovery?: Awaited<ReturnType<typeof runCatalogDiscovery>> }> => {
  const lease = await acquireAggregationLock(env, now);
  if (!lease) return { ran: false };
  try {
    await reconcileVotingSpikes(env, now);
    await recalculatePeriod(env, "live", now);
    await recalculatePeriod(env, "24h", now);
    await recalculatePeriod(env, "7d", now);
    await lockReleaseBaselines(env, now);
    await archiveExpiredRiskData(env, now);
    await cleanupCliTurnstileChallenges(env, now);
    // Nomination-only catalog discovery is failure-isolated inside the service,
    // so a broken feed can never prevent aggregation from completing.
    const discovery = await runCatalogDiscovery(env, now);
    await regeneratePublicCache(env, now);
    return { ran: true, discovery };
  } finally {
    await releaseAggregationLock(env, lease);
  }
};
