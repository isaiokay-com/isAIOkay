import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";
import { archiveExpiredRiskData, deleteOwnAccount, ensureProfile, getFeedbackAllowance, getPublicProfileRatingsPage, getPublicProfileView, getRankingFromD1, hasDeletedGitHubIdentity, latestAggregateBefore, setUserStatus, updateProfilePreferences } from "../../src/db/repositories";
import { loadPublicRanking } from "../../src/lib/cache";
import { FEEDBACK_EDIT_WINDOW_MS } from "../../src/lib/feedback";
import { getDeletedGitHubIdentityHash } from "../../src/lib/deleted-identity";
import { createAuth, DEVELOPMENT_USER_COOKIE, requireAdministrator } from "../../src/services/auth";
import { approveDeviceAuthorization, exchangeDeviceAuthorization, requireCliIdentity, startDeviceAuthorization } from "../../src/services/cli-auth";
import { resolveCliAgentItemId, resolveCliTrackedItem } from "../../src/services/cli-feedback";
import { lockReleaseBaselines, recalculatePeriod, reconcileVotingSpikes } from "../../src/services/aggregation";
import { prepareTestDatabase, insertItem } from "./setup";

const runtime = env as unknown as Env;
const itemA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const itemB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const itemC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const command = (
  userId: string,
  itemId: string,
  idempotencyKey = crypto.randomUUID(),
  signals: { ipHash?: string; deviceHash?: string } = {}
) => ({
  userId,
  now: Date.now(),
  report: {
    trackedItemId: itemId,
    resultQualityRating: 4,
    usageEfficiencyRating: 4,
    tags: ["useful"],
    idempotencyKey
  },
  effectiveWeight: 0.8,
  fraudRiskScore: 0,
  duplicateClusterAdjustment: 1,
  ipHash: signals.ipHash ?? "ip",
  deviceHash: signals.deviceHash ?? "device"
});

const ensureTestAccount = async (userId: string): Promise<void> => {
  const now = Date.now();
  await runtime.DB.batch([
    runtime.DB.prepare("insert or ignore into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Allowance user', ?, 1, ?, ?)")
      .bind(userId, `${userId}@allowance.test`, now, now),
    runtime.DB.prepare(
      "insert or ignore into user_profile (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at) values (?, ?, ?, ?, 'normal', 0.8, 'active', ?, ?)"
    ).bind(userId, `test-${userId}`, `user-${userId.slice(0, 8)}`, now - 365 * 86_400_000, now, now)
  ]);
};

const submit = async (input: ReturnType<typeof command>) => {
  await ensureTestAccount(input.userId);
  const stub = runtime.FEEDBACK_ALLOWANCE.get(runtime.FEEDBACK_ALLOWANCE.idFromName(input.userId));
  const response = await stub.fetch("https://allowance/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() as { accepted: boolean; idempotent: boolean; code?: string; reportId?: string; allowance: { remaining: number; alreadyRatedItemIds: string[] } } };
};

const edit = async (userId: string, reportId: string, now: number, resultQualityRating = 2) => {
  const stub = runtime.FEEDBACK_ALLOWANCE.get(runtime.FEEDBACK_ALLOWANCE.idFromName(userId));
  const response = await stub.fetch("https://allowance/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId,
      now,
      report: {
        reportId,
        agentItemId: null,
        resultQualityRating,
        usageEfficiencyRating: 3,
        tags: ["corrected"],
        shortComment: "Updated once"
      }
    })
  });
  return { status: response.status, body: await response.json() as { edited: boolean; code?: string; reportId?: string } };
};

beforeAll(async () => {
  await prepareTestDatabase(runtime);
  await Promise.all([insertItem(runtime, itemA, "item-a"), insertItem(runtime, itemB, "item-b"), insertItem(runtime, itemC, "item-c")]);
});

describe("FeedbackAllowance Durable Object", () => {
  it("enforces the same-item and two-report rolling limits", async () => {
    const userId = crypto.randomUUID();
    expect((await submit(command(userId, itemA))).status).toBe(201);
    const duplicate = await submit(command(userId, itemA));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("item_already_rated");
    expect((await submit(command(userId, itemB))).status).toBe(201);
    const exhausted = await submit(command(userId, itemC));
    expect(exhausted.status).toBe(429);
    expect(exhausted.body.allowance.remaining).toBe(0);
  });

  it("replays an idempotency key without a second report", async () => {
    const userId = crypto.randomUUID();
    const input = command(userId, itemA);
    expect((await submit(input)).status).toBe(201);
    const replay = await submit(input);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
    expect((await getFeedbackAllowance(runtime, userId)).remaining).toBe(1);
  });

  it("serializes concurrent requests from one user", async () => {
    const userId = crypto.randomUUID();
    const results = await Promise.all([submit(command(userId, itemA)), submit(command(userId, itemB)), submit(command(userId, itemC))]);
    expect(results.filter((result) => result.status === 201)).toHaveLength(2);
    expect(results.filter((result) => result.status === 429)).toHaveLength(1);
  });

  it("serializes deletion with reports and rejects stale or re-registered submissions", async () => {
    const userId = crypto.randomUUID();
    const created = await submit(command(userId, itemA));
    expect(created.status).toBe(201);
    const githubUserId = `test-${userId}`;
    const stub = runtime.FEEDBACK_ALLOWANCE.get(runtime.FEEDBACK_ALLOWANCE.idFromName(userId));
    const deletion = await stub.fetch("https://allowance/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, now: Date.now() })
    });
    expect(deletion.status).toBe(200);
    await expect(deletion.json()).resolves.toMatchObject({ deleted: true, previousUsername: `user-${userId.slice(0, 8)}` });
    await expect(hasDeletedGitHubIdentity(runtime, githubUserId)).resolves.toBe(true);

    const staleSubmission = await submit(command(userId, itemB));
    expect(staleSubmission).toMatchObject({ status: 403, body: { accepted: false, code: "account_unavailable" } });
    const reportCount = await runtime.DB.prepare("select count(*) as count from feedback_report where user_id = ?").bind(userId).first<{ count: number }>();
    expect(reportCount?.count).toBe(1);

    const replacementUserId = crypto.randomUUID();
    const now = Date.now();
    await runtime.DB.batch([
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Replacement user', ?, 1, ?, ?)").bind(replacementUserId, `${replacementUserId}@test.local`, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at) values (?, ?, ?, ?, 'normal', 0.8, 'active', ?, ?)").bind(replacementUserId, githubUserId, `replacement-${replacementUserId.slice(0, 8)}`, now - 365 * 86_400_000, now, now)
    ]);
    const replacementSubmission = await submit(command(replacementUserId, itemB));
    expect(replacementSubmission).toMatchObject({ status: 403, body: { accepted: false, code: "account_unavailable" } });
  });

  it("allows a suspended account to delete itself without restoring write access", async () => {
    const userId = crypto.randomUUID();
    await ensureTestAccount(userId);
    await runtime.DB.prepare("update user_profile set status = 'suspended' where user_id = ?").bind(userId).run();
    const stub = runtime.FEEDBACK_ALLOWANCE.get(runtime.FEEDBACK_ALLOWANCE.idFromName(userId));
    const deletion = await stub.fetch("https://allowance/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, now: Date.now() })
    });

    expect(deletion.status).toBe(200);
    await expect(deletion.json()).resolves.toMatchObject({ deleted: true });
    const profile = await runtime.DB.prepare("select status from user_profile where user_id = ?").bind(userId).first<{ status: string }>();
    expect(profile?.status).toBe("deleted");
    expect((await submit(command(userId, itemA))).status).toBe(403);
  });

  it("allows the latest web report to be edited once within ten minutes", async () => {
    const userId = crypto.randomUUID();
    const editableItemId = crypto.randomUUID();
    await insertItem(runtime, editableItemId, `editable-${editableItemId}`);
    const submittedAt = Date.now();
    const input = command(userId, editableItemId);
    input.now = submittedAt;
    const created = await submit(input);
    expect(created.status).toBe(201);
    await recalculatePeriod(runtime, "live", submittedAt + 30_000);
    const scoreBefore = await runtime.DB.prepare(
      "select overall_score from aggregate where tracked_item_id = ? and period = 'live' order by calculated_at desc limit 1"
    ).bind(editableItemId).first<{ overall_score: number }>();

    const firstEdit = await edit(userId, created.body.reportId!, submittedAt + 60_000);
    expect(firstEdit).toMatchObject({ status: 200, body: { edited: true, reportId: created.body.reportId } });
    const report = await runtime.DB.prepare(
      "select result_quality_rating, usage_efficiency_rating, tags_json, short_comment, edited_at from feedback_report where id = ?"
    ).bind(created.body.reportId).first<Record<string, unknown>>();
    expect(report).toMatchObject({
      result_quality_rating: 2,
      usage_efficiency_rating: 3,
      tags_json: '["corrected"]',
      short_comment: "Updated once",
      edited_at: submittedAt + 60_000
    });
    await recalculatePeriod(runtime, "live", submittedAt + 90_000);
    const scoreAfter = await runtime.DB.prepare(
      "select overall_score from aggregate where tracked_item_id = ? and period = 'live' order by calculated_at desc limit 1"
    ).bind(editableItemId).first<{ overall_score: number }>();
    expect(scoreAfter!.overall_score).toBeLessThan(scoreBefore!.overall_score);
    expect((await edit(userId, created.body.reportId!, submittedAt + 120_000)).body.code).toBe("edit_already_used");
    const audit = await runtime.DB.prepare(
      "select action, actor_user_id from audit_log where entity_id = ? order by created_at desc limit 1"
    ).bind(created.body.reportId).first<{ action: string; actor_user_id: string }>();
    expect(audit).toEqual({ action: "edit_own_report", actor_user_id: userId });
  });

  it("rejects an expired edit and a report that is no longer latest", async () => {
    const expiredUserId = crypto.randomUUID();
    const submittedAt = Date.now();
    const expiredInput = command(expiredUserId, itemA);
    expiredInput.now = submittedAt;
    const expiredReport = await submit(expiredInput);
    expect((await edit(expiredUserId, expiredReport.body.reportId!, submittedAt + FEEDBACK_EDIT_WINDOW_MS)).body.code).toBe("edit_expired");

    const latestUserId = crypto.randomUUID();
    const firstInput = command(latestUserId, itemA);
    firstInput.now = submittedAt;
    const first = await submit(firstInput);
    const secondInput = command(latestUserId, itemB);
    secondInput.now = submittedAt + 1;
    expect((await submit(secondInput)).status).toBe(201);
    expect((await edit(latestUserId, first.body.reportId!, submittedAt + 2)).body.code).toBe("edit_not_latest");
  });

  it("allows the latest CLI rating to be corrected from the website", async () => {
    const userId = crypto.randomUUID();
    const submittedAt = Date.now();
    const input = command(userId, itemA);
    input.now = submittedAt;
    const created = await submit(input);
    await runtime.DB.prepare("update feedback_report set source = 'cli' where id = ?").bind(created.body.reportId).run();

    expect(await edit(userId, created.body.reportId!, submittedAt + 1_000)).toMatchObject({
      status: 200,
      body: { edited: true }
    });
  });

  it("retroactively downweights a cross-user device cluster before aggregation", async () => {
    const deviceHash = `cluster-${crypto.randomUUID()}`;
    const inputs = [itemA, itemB, itemC].map((itemId) =>
      command(crypto.randomUUID(), itemId, crypto.randomUUID(), { deviceHash, ipHash: crypto.randomUUID() })
    );
    const inserted = await Promise.all(inputs.map(submit));
    expect(inserted.every((result) => result.status === 201)).toBe(true);

    await reconcileVotingSpikes(runtime, Date.now());
    const reports = await runtime.DB.prepare(
      "select duplicate_cluster_adjustment, fraud_risk_score from feedback_report where device_hash = ?"
    ).bind(deviceHash).all<{ duplicate_cluster_adjustment: number; fraud_risk_score: number }>();
    expect(reports.results).toHaveLength(3);
    expect(reports.results.every((report) => report.duplicate_cluster_adjustment === 0.4)).toBe(true);
    expect(reports.results.every((report) => report.fraud_risk_score >= 0.45)).toBe(true);
  });

  it("removes network and device hashes after the configured risk window", async () => {
    const now = Date.now();
    const reportId = crypto.randomUUID();
    await runtime.DB.prepare(
      `insert into feedback_report (
        id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json,
        effective_weight, moderation_status, fraud_risk_score, included_in_scores,
        duplicate_cluster_adjustment, ip_hash, device_hash, idempotency_key,
        submitted_at, created_at, updated_at
      ) values (?, ?, ?, 4, 4, '[]', 1, 'approved', 0, 1, 1, 'old-ip', 'old-device', ?, ?, ?, ?)`
    ).bind(reportId, crypto.randomUUID(), itemA, crypto.randomUUID(), now - 31 * 86_400_000, now, now).run();

    await archiveExpiredRiskData(runtime, now);
    const report = await runtime.DB.prepare("select ip_hash, device_hash from feedback_report where id = ?")
      .bind(reportId).first<{ ip_hash: string | null; device_hash: string | null }>();
    expect(report).toEqual({ ip_hash: null, device_hash: null });
  });

  it("falls back to D1 when the public KV payload is missing", async () => {
    await runtime.PUBLIC_CACHE.delete("rankings:7d:v8");
    const fallback = await loadPublicRanking(runtime, "7d");
    expect(fallback.source).toBe("d1");
    expect(fallback.payload.items.length).toBeGreaterThanOrEqual(3);
    expect(fallback.payload.items.every((item) => item.type === "model")).toBe(true);
    const direct = await getRankingFromD1(runtime, "7d");
    expect(direct.schemaVersion).toBe(8);
  });

  it("does not expose unsafe legacy links from D1", async () => {
    const itemId = crypto.randomUUID();
    await insertItem(runtime, itemId, `unsafe-link-${itemId}`);
    await runtime.DB.prepare(
      "update tracked_item set official_url = 'javascript:alert(1)', release_source_url = 'http://insecure.example/release' where id = ?"
    ).bind(itemId).run();

    const item = (await getRankingFromD1(runtime, "live")).items.find((candidate) => candidate.id === itemId);
    expect(item).toMatchObject({ officialUrl: null, releaseSourceUrl: null });
  });

  it("keeps older ratings in the live aggregate after fixed windows expire", async () => {
    const now = Date.now();
    const oldItemId = crypto.randomUUID();
    const oldUserId = crypto.randomUUID();
    await insertItem(runtime, oldItemId, `old-${oldItemId}`);
    await runtime.DB.prepare(
      `insert into feedback_report (
        id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json,
        effective_weight, moderation_status, fraud_risk_score, included_in_scores,
        duplicate_cluster_adjustment, idempotency_key, submitted_at, created_at, updated_at
      ) values (?, ?, ?, 5, 5, '[]', 1, 'approved', 0, 1, 1, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), oldUserId, oldItemId, crypto.randomUUID(), now - 30 * 86_400_000, now, now).run();

    await recalculatePeriod(runtime, "live", now);
    await recalculatePeriod(runtime, "7d", now);
    const aggregates = await runtime.DB.prepare(
      "select period, report_count, overall_score from aggregate where tracked_item_id = ? and period in ('live', '7d')"
    ).bind(oldItemId).all<{ period: string; report_count: number; overall_score: number }>();
    const live = aggregates.results.find((row) => row.period === "live");
    const fixed = aggregates.results.find((row) => row.period === "7d");
    expect(live).toMatchObject({ report_count: 1 });
    expect(live!.overall_score).toBeGreaterThan(60);
    expect(fixed).toMatchObject({ report_count: 0 });
  });

  it("updates one aggregate snapshot per UTC day instead of appending every run", async () => {
    const itemId = crypto.randomUUID();
    const firstRun = Date.UTC(2026, 7, 5, 4, 0);
    await insertItem(runtime, itemId, `daily-${itemId}`);

    await recalculatePeriod(runtime, "live", firstRun);
    await recalculatePeriod(runtime, "live", firstRun + 10 * 60_000);
    const sameDay = await runtime.DB.prepare(
      "select count(*) as count, max(calculated_at) as calculated_at from aggregate where tracked_item_id = ? and period = 'live'"
    ).bind(itemId).first<{ count: number; calculated_at: number }>();
    expect(sameDay).toEqual({ count: 1, calculated_at: firstRun + 10 * 60_000 });

    await recalculatePeriod(runtime, "live", firstRun + 86_400_000);
    const nextDay = await runtime.DB.prepare(
      "select count(*) as count from aggregate where tracked_item_id = ? and period = 'live'"
    ).bind(itemId).first<{ count: number }>();
    expect(nextDay?.count).toBe(2);
  });

  it("compares with the latest snapshot from the target UTC day", async () => {
    const itemId = crypto.randomUUID();
    const firstDayLate = Date.UTC(2026, 7, 5, 23, 50);
    const nextDayEarly = Date.UTC(2026, 7, 6, 5, 10);
    await insertItem(runtime, itemId, `comparison-${itemId}`);

    await recalculatePeriod(runtime, "live", firstDayLate);
    await recalculatePeriod(runtime, "live", nextDayEarly);
    const previous = await latestAggregateBefore(runtime, itemId, "live", nextDayEarly - 86_400_000);

    expect(previous?.calculatedAt).toBe(firstDayLate);
  });

  it("labels a D1 fallback with its completed aggregate time, not the request time", async () => {
    const snapshotAt = Date.now() + 60_000;
    await recalculatePeriod(runtime, "live", snapshotAt);
    const payload = await getRankingFromD1(runtime, "live", snapshotAt + 2 * 86_400_000);
    expect(payload.generatedAt).toBe(new Date(snapshotAt).toISOString());
    expect(payload.expiresAt).toBe(new Date(snapshotAt + 10 * 60_000).toISOString());
  });

  it("orders the assembled API payload with the same Developer Signal comparator", async () => {
    const now = Date.now() + 120_000;
    const broadId = crypto.randomUUID();
    const narrowId = crypto.randomUUID();
    await insertItem(runtime, broadId, `broad-${broadId}`);
    await insertItem(runtime, narrowId, `narrow-${narrowId}`);
    const broadReports = Array.from({ length: 20 }, () => runtime.DB.prepare(
      `insert into feedback_report (
        id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json,
        effective_weight, moderation_status, fraud_risk_score, included_in_scores,
        duplicate_cluster_adjustment, idempotency_key, submitted_at, created_at, updated_at
      ) values (?, ?, ?, 4, 4, '[]', 1, 'approved', 0, 1, 1, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), crypto.randomUUID(), broadId, crypto.randomUUID(), now - 1_000, now, now));
    const narrowReport = runtime.DB.prepare(
      `insert into feedback_report (
        id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json,
        effective_weight, moderation_status, fraud_risk_score, included_in_scores,
        duplicate_cluster_adjustment, idempotency_key, submitted_at, created_at, updated_at
      ) values (?, ?, ?, 5, 5, '[]', 1, 'approved', 0, 1, 1, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), crypto.randomUUID(), narrowId, crypto.randomUUID(), now - 1_000, now, now);
    await runtime.DB.batch([...broadReports, narrowReport]);
    await recalculatePeriod(runtime, "live", now);
    await runtime.DB.batch([
      runtime.DB.prepare("update aggregate set overall_score = 80, confidence = 90, report_count = 20 where tracked_item_id = ? and period = 'live' and calculated_at = ?").bind(broadId, now),
      runtime.DB.prepare("update aggregate set overall_score = 90, confidence = 5, report_count = 1 where tracked_item_id = ? and period = 'live' and calculated_at = ?").bind(narrowId, now)
    ]);
    const payload = await getRankingFromD1(runtime, "live", now + 1_000);
    expect(payload.items.findIndex((item) => item.id === broadId)).toBeLessThan(payload.items.findIndex((item) => item.id === narrowId));
  });

  it("keeps a frozen release baseline immutable during scheduled recalculation", async () => {
    const now = Date.now();
    const releaseAt = now - 30 * 86_400_000;
    const baselineStart = releaseAt + 48 * 60 * 60_000;
    const baselineEnd = baselineStart + 7 * 86_400_000;
    const itemId = crypto.randomUUID();
    const baselineId = crypto.randomUUID();
    await insertItem(runtime, itemId, `baseline-${itemId}`);
    await runtime.DB.batch([
      runtime.DB.prepare("update tracked_item set release_at = ?, baseline_start_at = ?, baseline_end_at = ?, baseline_locked_at = ?, baseline_method_version = 'v1' where id = ?")
        .bind(releaseAt, baselineStart, baselineEnd, baselineEnd, itemId),
      runtime.DB.prepare(
        "insert into aggregate (id, tracked_item_id, period, period_start, period_end, report_count, weighted_report_count, overall_score, result_quality_score, usage_efficiency_score, confidence, change, state, snapshot_day, calculated_at) values (?, ?, 'release_baseline', ?, ?, 12, 12, 80, 80, 80, 70, 0, 'steady', ?, ?)"
      ).bind(baselineId, itemId, baselineStart, baselineEnd, Math.floor(baselineEnd / 86_400_000) * 86_400_000, baselineEnd)
    ]);
    await lockReleaseBaselines(runtime, now);
    const baseline = await runtime.DB.prepare("select id, overall_score from aggregate where tracked_item_id = ? and period = 'release_baseline'")
      .bind(itemId).first<{ id: string; overall_score: number }>();
    expect(baseline).toEqual({ id: baselineId, overall_score: 80 });
  });

  it("constructs Better Auth with the native runtime D1 binding", () => {
    const auth = createAuth({ ...runtime, BETTER_AUTH_SECRET: "development-test-secret-with-enough-length", BETTER_AUTH_URL: "http://localhost:8787" });
    expect(auth.options.database).toBe(runtime.DB);
  });

  it("configures GitHub OAuth without default email or repository scopes", () => {
    const auth = createAuth({
      ...runtime,
      BETTER_AUTH_SECRET: "development-test-secret-with-enough-length",
      BETTER_AUTH_URL: "http://localhost:8787",
      GITHUB_CLIENT_ID: "test-github-client",
      GITHUB_CLIENT_SECRET: "test-github-secret"
    });
    expect(auth.options.socialProviders?.github).toMatchObject({ disableDefaultScope: true });
  });

  it("does not expose Better Auth's generic identity update endpoint", async () => {
    const auth = createAuth({
      ...runtime,
      BETTER_AUTH_SECRET: "development-test-secret-with-enough-length",
      BETTER_AUTH_URL: "http://localhost:8787",
      GITHUB_CLIENT_ID: "test-github-client",
      GITHUB_CLIENT_SECRET: "test-github-secret"
    });
    const response = await auth.handler(new Request("http://localhost:8787/api/auth/update-user", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:8787" },
      body: JSON.stringify({ githubUsername: "not-the-github-handle" })
    }));

    expect(response.status).toBe(404);
  });

  it("rechecks the deleted-identity ledger at Better Auth write boundaries", async () => {
    const githubUserId = String(900_000 + Math.floor(Math.random() * 90_000));
    const identityHash = await getDeletedGitHubIdentityHash(runtime.DELETED_IDENTITY_SECRET, githubUserId);
    await runtime.DB.prepare("insert into deleted_identity (identity_hash, deleted_at) values (?, ?)").bind(identityHash, Date.now()).run();
    const auth = createAuth({
      ...runtime,
      BETTER_AUTH_URL: "http://localhost:8787",
      GITHUB_CLIENT_ID: "test-github-client",
      GITHUB_CLIENT_SECRET: "test-github-secret"
    });
    const createUserHook = auth.options.databaseHooks?.user?.create?.before;
    const updateUserHook = auth.options.databaseHooks?.user?.update?.before;
    const createAccountHook = auth.options.databaseHooks?.account?.create?.before;
    expect(createUserHook).toBeTypeOf("function");
    expect(updateUserHook).toBeTypeOf("function");
    expect(createAccountHook).toBeTypeOf("function");

    await expect(createUserHook!({ email: `github-${githubUserId}@isaiokay.invalid` } as never))
      .rejects.toThrow("deleted account");
    await expect(updateUserHook!({ email: `github-${githubUserId}@isaiokay.invalid` } as never))
      .rejects.toThrow("deleted account");
    await expect(createAccountHook!({ providerId: "github", accountId: githubUserId } as never))
      .rejects.toThrow("deleted account");
  });

  it("uses GitHub for profile ownership while keeping X as editable self-declared metadata", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    const githubUsername = `exact-${crypto.randomUUID().slice(0, 6)}`;
    await runtime.DB.prepare(
      "insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, ?, ?, 1, ?, ?)"
    ).bind(userId, "Different Display Name", userId, now, now).run();

    const profile = await ensureProfile({
      env: runtime,
      userId,
      name: "Different Display Name",
      image: null,
      githubUserId: `gh-${userId}`,
      githubUsername,
      githubAccountCreatedAt: now - 365 * 86_400_000,
      now
    });

    expect(profile).toMatchObject({
      githubUsername,
      githubDisplayName: "Different Display Name",
      xUsername: null,
      trustCategory: "normal"
    });

    await updateProfilePreferences(runtime, userId, { publicProfileEnabled: false, xUsername: "Exact_X_Handle" });
    expect(await getPublicProfileView(runtime, githubUsername, userId)).toMatchObject({
      username: githubUsername,
      xUsername: "Exact_X_Handle"
    });

    const renamedUsername = `renamed-${crypto.randomUUID().slice(0, 6)}`;
    const refreshed = await ensureProfile({
      env: runtime,
      userId,
      name: "Different Display Name",
      image: null,
      githubUserId: `gh-${userId}`,
      githubUsername: renamedUsername,
      githubAccountCreatedAt: now - 365 * 86_400_000,
      now: now + 1
    });
    expect(refreshed).toMatchObject({ githubUsername: renamedUsername, xUsername: "Exact_X_Handle" });
    await expect(getPublicProfileView(runtime, githubUsername, userId)).resolves.toBeNull();
    await expect(getPublicProfileView(runtime, renamedUsername, userId)).resolves.toMatchObject({ xUsername: "Exact_X_Handle" });

    await updateProfilePreferences(runtime, userId, { publicProfileEnabled: false, xUsername: null });
    await expect(getPublicProfileView(runtime, renamedUsername, userId)).resolves.toMatchObject({ xUsername: null });
  });



  it("self-deletes identity and access data while retaining de-identified rating records", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    const username = `delete-${crypto.randomUUID().slice(0, 7)}`;
    const installationId = crypto.randomUUID();
    const contextId = crypto.randomUUID();
    const auditEntityId = crypto.randomUUID();
    await runtime.DB.batch([
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, image, githubUsername, githubAccountCreatedAt, createdAt, updatedAt) values (?, 'Delete Me', ?, 1, 'https://example.com/avatar', ?, ?, ?, ?)").bind(userId, `${userId}@test.local`, username, now - 365 * 86_400_000, now, now),
      runtime.DB.prepare("insert into account (id, userId, accountId, providerId, createdAt, updatedAt) values (?, ?, ?, 'github', ?, ?)").bind(crypto.randomUUID(), userId, `gh-${userId}`, now, now),
      runtime.DB.prepare("insert into session (id, userId, token, expiresAt, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, crypto.randomUUID(), now + 60_000, now, now),
      runtime.DB.prepare("insert into verification (id, identifier, value, expiresAt, createdAt, updatedAt) values (?, ?, 'verification-value', ?, ?, ?)").bind(crypto.randomUUID(), `${userId}@test.local`, now + 60_000, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_display_name, github_avatar_url, github_account_created_at, x_username, trust_category, trust_weight, status, public_profile_enabled, first_login_at, last_login_at) values (?, ?, ?, 'Delete Me', 'https://example.com/avatar', ?, 'delete_me', 'normal', 0.8, 'active', 1, ?, ?)").bind(userId, `gh-${userId}`, username, now - 365 * 86_400_000, now, now),
      runtime.DB.prepare("insert into cli_installation (id, user_id, label, token_hash, scopes_json, created_at, expires_at) values (?, ?, 'Delete CLI', ?, '[]', ?, ?)").bind(installationId, userId, crypto.randomUUID(), now, now + 60_000),
      runtime.DB.prepare("insert into cli_device_authorization (id, device_code_hash, user_code, status, user_id, client_name, created_at, expires_at) values (?, ?, ?, 'approved', ?, 'Delete CLI', ?, ?)").bind(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID().slice(0, 8), userId, now, now + 60_000),
      runtime.DB.prepare("insert into feedback_context (id, user_id, installation_id, tracked_item_id, session_hash, tool, attribution, adapter_version, created_at) values (?, ?, ?, ?, ?, 'codex', 'verified_active', '1.0.0', ?)").bind(contextId, userId, installationId, itemA, "f".repeat(64), now),
      runtime.DB.prepare("insert into feedback_report (id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json, short_comment, effective_weight, moderation_status, fraud_risk_score, included_in_scores, duplicate_cluster_adjustment, ip_hash, device_hash, idempotency_key, source, feedback_context_id, client_event_id, submitted_at, created_at, updated_at) values (?, ?, ?, 4, 2, '[\"personal-tag\"]', 'private note', 0.8, 'approved', 0.45, 1, 1, 'ip-hash', 'device-hash', ?, 'cli', ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, itemA, crypto.randomUUID(), contextId, crypto.randomUUID(), now, now, now),
      runtime.DB.prepare("insert into risk_event (id, user_id, kind, score, expires_at, created_at) values (?, ?, 'test', 0.2, ?, ?)").bind(crypto.randomUUID(), userId, now + 60_000, now),
      runtime.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) values (?, ?, 'edit_own_report', 'feedback_report', ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, auditEntityId, JSON.stringify({ shortComment: "private note" }), JSON.stringify({ tags: ["personal-tag"] }), now)
    ]);

    await expect(deleteOwnAccount(runtime, userId, now + 1)).resolves.toEqual({ previousUsername: username });
    await expect(getPublicProfileView(runtime, username, null)).resolves.toBeNull();
    const profile = await runtime.DB.prepare("select * from user_profile where user_id = ?").bind(userId).first<Record<string, unknown>>();
    expect(profile).toMatchObject({ status: "deleted", public_profile_enabled: 0, x_username: null, github_display_name: null, github_avatar_url: null });
    expect(profile).toMatchObject({ github_account_created_at: 0, first_login_at: now + 1, last_login_at: now + 1 });
    expect(String(profile?.github_username)).toMatch(/^deleted-/);
    await expect(hasDeletedGitHubIdentity(runtime, `gh-${userId}`)).resolves.toBe(true);
    await expect(setUserStatus({ env: runtime, userId, status: "active", actorUserId: crypto.randomUUID() }))
      .rejects.toThrow("cannot be reactivated");
    await expect(runtime.DB.prepare("update user set name = 'Restored identity' where id = ?").bind(userId).run())
      .rejects.toThrow("deleted account is immutable");
    await expect(runtime.DB.prepare("insert into account (id, userId, accountId, providerId, createdAt, updatedAt) values (?, ?, 'restored', 'github', ?, ?)").bind(crypto.randomUUID(), userId, now + 2, now + 2).run())
      .rejects.toThrow("deleted account cannot create access data");
    await expect(runtime.DB.prepare("insert into session (id, userId, token, expiresAt, createdAt, updatedAt) values (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, crypto.randomUUID(), now + 60_000, now + 2, now + 2).run())
      .rejects.toThrow("deleted account cannot create access data");
    await expect(runtime.DB.prepare("update user_profile set status = 'active' where user_id = ?").bind(userId).run())
      .rejects.toThrow("deleted account cannot be reactivated");
    const report = await runtime.DB.prepare("select id, result_quality_rating, usage_efficiency_rating, tags_json, short_comment, ip_hash, device_hash, feedback_context_id, idempotency_key, client_event_id from feedback_report where user_id = ?").bind(userId).first<Record<string, unknown>>();
    expect(report).toMatchObject({ result_quality_rating: 4, usage_efficiency_rating: 2, tags_json: "[]", short_comment: null, ip_hash: null, device_hash: null, feedback_context_id: null, client_event_id: null });
    expect(report?.idempotency_key).toBe(`deleted:${report?.id}`);
    for (const [table, column] of [["account", "userId"], ["session", "userId"], ["cli_installation", "user_id"], ["cli_device_authorization", "user_id"], ["feedback_context", "user_id"], ["risk_event", "user_id"]] as const) {
      const count = await runtime.DB.prepare(`select count(*) as count from ${table} where ${column} = ?`).bind(userId).first<{ count: number }>();
      expect(count?.count, table).toBe(0);
    }
    const verificationCount = await runtime.DB.prepare("select count(*) as count from verification where identifier = ?").bind(`${userId}@test.local`).first<{ count: number }>();
    expect(verificationCount?.count).toBe(0);
    const oldAudit = await runtime.DB.prepare("select actor_user_id, before_json, after_json from audit_log where entity_id = ?").bind(auditEntityId).first<Record<string, unknown>>();
    expect(oldAudit).toEqual({ actor_user_id: null, before_json: null, after_json: null });
    await reconcileVotingSpikes(runtime, now + 2);
    const recreatedRiskCount = await runtime.DB.prepare("select count(*) as count from risk_event where user_id = ?").bind(userId).first<{ count: number }>();
    expect(recreatedRiskCount?.count).toBe(0);
  });

  it("requires a profile administrator or stable GitHub allowlist for admin operations", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    await runtime.DB.batch([
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Test user', ?, 1, ?, ?)").bind(userId, `${userId}@test.local`, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at) values (?, 'not-admin', ?, ?, 'normal', 0.8, 'active', ?, ?)").bind(userId, `user-${userId.slice(0, 8)}`, now - 365 * 86_400_000, now, now)
    ]);
    const testEnv = {
      ...runtime,
      BETTER_AUTH_URL: "http://localhost:8787",
      MOCK_GITHUB_AUTH: "true",
      ADMIN_GITHUB_USER_IDS: "101004"
    };
    const request = new Request("http://localhost/admin", { headers: { cookie: `${DEVELOPMENT_USER_COOKIE}=${userId}` } });
    await expect(requireAdministrator(request, testEnv)).rejects.toMatchObject({ status: 403 });
    await runtime.DB.prepare("update user_profile set github_user_id = '101004' where user_id = ?").bind(userId).run();
    await expect(requireAdministrator(request, testEnv)).resolves.toMatchObject({ userId });
    const auditId = crypto.randomUUID();
    await runtime.DB.batch([
      runtime.DB.prepare("update user_profile set status = 'admin' where user_id = ?").bind(userId),
      runtime.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, after_json, created_at) values (?, ?, 'change_scoring_configuration', 'settings', 'app', ?, ?)")
        .bind(auditId, userId, JSON.stringify({ preserved: true }), now)
    ]);
    await expect(deleteOwnAccount(runtime, userId, now + 1)).rejects.toThrow("Administrators must be demoted");
    await runtime.DB.prepare("update user_profile set status = 'active' where user_id = ?").bind(userId).run();
    await expect(deleteOwnAccount(testEnv, userId, now + 1)).rejects.toThrow("removed from the allowlist");
    const audit = await runtime.DB.prepare("select actor_user_id, after_json from audit_log where id = ?").bind(auditId).first<Record<string, unknown>>();
    expect(audit).toEqual({ actor_user_id: userId, after_json: JSON.stringify({ preserved: true }) });
  });

  it("keeps GitHub-linked report activity private until the owner opts in", async () => {
    const now = Date.now();
    const userId = crypto.randomUUID();
    const username = `builder-${crypto.randomUUID().slice(0, 7)}`;
    const modelId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    await insertItem(runtime, modelId, `profile-model-${modelId}`);
    await insertItem(runtime, agentId, `profile-agent-${agentId}`);
    await runtime.DB.batch([
      runtime.DB.prepare("update tracked_item set type = 'agent', name = 'Profile Agent' where id = ?").bind(agentId),
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Profile Builder', ?, 1, ?, ?)").bind(userId, `${userId}@test.local`, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_display_name, github_account_created_at, x_username, trust_category, trust_weight, status, public_profile_enabled, first_login_at, last_login_at) values (?, ?, ?, 'Profile Builder', ?, 'optional_x', 'normal', 0.8, 'active', 0, ?, ?)")
        .bind(userId, `gh-${userId}`, username, now - 365 * 86_400_000, now, now),
      runtime.DB.prepare(
        `insert into feedback_report (
          id, user_id, tracked_item_id, agent_item_id, result_quality_rating, usage_efficiency_rating, tags_json, short_comment,
          effective_weight, moderation_status, fraud_risk_score, included_in_scores,
          duplicate_cluster_adjustment, idempotency_key, source, submitted_at, created_at, updated_at
        ) values (?, ?, ?, ?, 2, 3, '[]', 'private note', 0.8, 'approved', 0, 1, 1, ?, 'web', ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, modelId, agentId, crypto.randomUUID(), now, now, now)
    ]);

    await expect(getPublicProfileView(runtime, username, null)).resolves.toBeNull();
    const ownerView = await getPublicProfileView(runtime, username, userId);
    expect(ownerView).toMatchObject({ isOwner: true, isPublic: false, reportCount: 1 });
    expect(ownerView?.reports[0]).toMatchObject({ agentName: "Profile Agent", resultQualityRating: 2, usageEfficiencyRating: 3 });
    expect(ownerView?.reports[0]).not.toHaveProperty("shortComment");
    await updateProfilePreferences(runtime, userId, { publicProfileEnabled: true, xUsername: "optional_x" });
    await expect(getPublicProfileView(runtime, username, null)).resolves.toMatchObject({ isOwner: false, isPublic: true, reportCount: 1, xUsername: "optional_x" });
  });

  it("keeps a suspended profile private while preserving its owner deletion surface", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    const username = `suspended-${crypto.randomUUID().slice(0, 7)}`;
    await runtime.DB.batch([
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Suspended user', ?, 1, ?, ?)").bind(userId, `${userId}@test.local`, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, public_profile_enabled, first_login_at, last_login_at) values (?, ?, ?, ?, 'normal', 0.8, 'suspended', 1, ?, ?)")
        .bind(userId, `gh-${userId}`, username, now - 365 * 86_400_000, now, now)
    ]);

    await expect(getPublicProfileView(runtime, username, null)).resolves.toBeNull();
    await expect(getPublicProfileView(runtime, username, crypto.randomUUID())).resolves.toBeNull();
    await expect(getPublicProfileView(runtime, username, userId)).resolves.toMatchObject({
      isOwner: true,
      isPublic: false,
      username
    });
  });

  it("paginates public profile ratings with a stable cursor", async () => {
    const now = Date.now();
    const userId = crypto.randomUUID();
    const username = `ratings-${crypto.randomUUID().slice(0, 7)}`;
    const modelId = crypto.randomUUID();
    await insertItem(runtime, modelId, `ratings-model-${modelId}`);
    await runtime.DB.batch([
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Ratings Builder', ?, 1, ?, ?)").bind(userId, `${userId}@test.local`, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_display_name, github_account_created_at, trust_category, trust_weight, status, public_profile_enabled, first_login_at, last_login_at) values (?, ?, ?, 'Ratings Builder', ?, 'normal', 0.8, 'active', 1, ?, ?)")
        .bind(userId, `gh-${userId}`, username, now - 365 * 86_400_000, now, now),
      ...Array.from({ length: 12 }, (_, index) => runtime.DB.prepare(
        `insert into feedback_report (
          id, user_id, tracked_item_id, result_quality_rating, usage_efficiency_rating, tags_json,
          effective_weight, moderation_status, fraud_risk_score, included_in_scores,
          duplicate_cluster_adjustment, idempotency_key, source, submitted_at, created_at, updated_at
        ) values (?, ?, ?, 4, 3, '[]', 0.8, 'approved', 0, 1, 1, ?, 'web', ?, ?, ?)`
      ).bind(crypto.randomUUID(), userId, modelId, crypto.randomUUID(), now - index, now - index, now - index))
    ]);

    const profile = await getPublicProfileView(runtime, username, null);
    expect(profile).toMatchObject({ reportCount: 12, ratingsNextCursor: expect.any(String) });
    expect(profile?.reports).toHaveLength(10);
    expect(profile?.mostUsedModels[0]).toMatchObject({ reports: 12 });

    const nextPage = await getPublicProfileRatingsPage(runtime, userId, profile?.ratingsNextCursor ?? null);
    expect(nextPage.reports).toHaveLength(2);
    expect(nextPage.nextCursor).toBeNull();
    expect(nextPage.reports[0]!.submittedAt).toBeLessThan(profile!.reports.at(-1)!.submittedAt);
  });

  it("exchanges device codes approved by the browser identity or an existing CLI", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    await runtime.DB.batch([
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'CLI user', ?, 1, ?, ?)").bind(userId, `${userId}@test.local`, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at) values (?, ?, ?, ?, 'normal', 0.8, 'active', ?, ?)").bind(userId, `gh-${userId}`, `user-${userId.slice(0, 8)}`, now - 365 * 86_400_000, now - 86_400_000, now)
    ]);
    const profile = await runtime.DB.prepare("select * from user_profile where user_id = ?").bind(userId).first();
    expect(profile).toBeTruthy();
    const started = await startDeviceAuthorization(runtime, "test-cli", now);
    const identity = {
      userId,
      name: "CLI user",
      image: null,
      profile: {
        userId,
        githubUserId: `gh-${userId}`,
        githubUsername: `user-${userId.slice(0, 8)}`,
        githubDisplayName: "CLI user",
        githubAvatarUrl: null,
        githubAccountCreatedAt: now - 365 * 86_400_000,
        xUsername: null,
        trustCategory: "normal" as const,
        trustWeight: 0.8,
        status: "active" as const,
        publicProfileEnabled: false,
        firstLoginAt: now - 86_400_000,
        lastLoginAt: now,
        deletedAt: null
      },
      isDevelopmentMock: false
    };
    await approveDeviceAuthorization(runtime, identity, started.userCode, now + 1);
    const token = await exchangeDeviceAuthorization(runtime, started.deviceCode, now + 2);
    expect(token.accessToken).toMatch(/^iai_[a-f0-9]{64}$/);
    expect(await runtime.DB.prepare("select token_hash from cli_installation where user_id = ?").bind(userId).first<{ token_hash: string }>())
      .not.toMatchObject({ token_hash: token.accessToken });
    const authenticated = await requireCliIdentity(new Request("https://isaiokay.test/api/cli/allowance", {
      headers: { authorization: `Bearer ${token.accessToken}` }
    }), runtime, "allowance:read");
  expect(authenticated).toMatchObject({ userId, scopes: ["allowance:read", "feedback:write", "subscriptions:write", "usage:write", "usage:read"] });

    const headless = await startDeviceAuthorization(runtime, "headless-cli", now + 3);
    await approveDeviceAuthorization(runtime, authenticated, headless.userCode, now + 4);
    const headlessToken = await exchangeDeviceAuthorization(runtime, headless.deviceCode, now + 5);
    const headlessIdentity = await requireCliIdentity(new Request("https://isaiokay.test/api/cli/allowance", {
      headers: { authorization: `Bearer ${headlessToken.accessToken}` }
    }), runtime, "allowance:read");
  expect(headlessIdentity).toMatchObject({ userId, scopes: ["allowance:read", "feedback:write", "subscriptions:write", "usage:write", "usage:read"] });
  });

  it("does not recreate CLI access after an authenticated account becomes unavailable", async () => {
    const userId = crypto.randomUUID();
    const now = Date.now();
    await runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Stale CLI user', ?, 1, ?, ?)")
      .bind(userId, `${userId}@test.local`, now, now).run();
    const profile = await ensureProfile({
      env: runtime,
      userId,
      name: "Stale CLI user",
      image: null,
      githubUserId: `gh-${userId}`,
      githubUsername: `stale-${userId.slice(0, 8)}`,
      githubAccountCreatedAt: now - 365 * 86_400_000,
      now
    });
    const identity = { userId, name: "Stale CLI user", image: null, profile, isDevelopmentMock: false };
    const pending = await startDeviceAuthorization(runtime, "pending-after-delete", now);
    const approved = await startDeviceAuthorization(runtime, "approved-before-delete", now);
    await approveDeviceAuthorization(runtime, identity, approved.userCode, now + 1);
    await runtime.DB.prepare("update user_profile set status = 'deleted' where user_id = ?").bind(userId).run();

    await expect(approveDeviceAuthorization(runtime, identity, pending.userCode, now + 2))
      .rejects.toMatchObject({ status: 409, code: "device_code_unavailable" });
    const pendingRecord = await runtime.DB.prepare("select status, user_id from cli_device_authorization where user_code = ?")
      .bind(pending.userCode.replace("-", "")).first<Record<string, unknown>>();
    expect(pendingRecord).toEqual({ status: "pending", user_id: null });

    await expect(exchangeDeviceAuthorization(runtime, approved.deviceCode, now + 3))
      .rejects.toMatchObject({ status: 409, code: "device_code_unavailable" });
    const installation = await runtime.DB.prepare("select id from cli_installation where user_id = ?").bind(userId).first();
    expect(installation).toBeNull();
  });

  it("resolves verified model aliases and records opaque host agents without ranking them", async () => {
    const now = Date.now();
    await runtime.DB.prepare(
      "insert or ignore into model_alias (id, tool, raw_label, normalized_label, tracked_item_id, created_at, updated_at) values (?, 'codex', 'openai/gpt-5', 'openai-gpt-5', ?, ?, ?)"
    ).bind(crypto.randomUUID(), itemA, now, now).run();
    const verified = await resolveCliTrackedItem(runtime, {
      tool: "codex",
      rawModelLabel: "openai/gpt-5",
      attribution: "verified_active",
      adapterVersion: "1.0.0",
      sessionHash: "a".repeat(64),
      sessionDurationBucket: "10_30m",
      resultQualityRating: 4,
      usageEfficiencyRating: 4,
      tags: [],
      clientEventId: crypto.randomUUID()
    });
    expect(verified.item.id).toBe(itemA);

    await runtime.DB.prepare("update tracked_item set slug = 'cursor', type = 'agent' where id = ?").bind(itemC).run();
    const opaqueInput = {
      tool: "cursor" as const,
      rawModelLabel: "Auto",
      attribution: "opaque_router" as const,
      adapterVersion: "1.0.0",
      sessionHash: "b".repeat(64),
      sessionDurationBucket: "30_60m" as const,
      resultQualityRating: 2,
      usageEfficiencyRating: 3,
      tags: [],
      clientEventId: crypto.randomUUID()
    };
    await expect(resolveCliTrackedItem(runtime, opaqueInput)).rejects.toMatchObject({ code: "model_confirmation_required" });
    await expect(resolveCliAgentItemId(runtime, opaqueInput)).resolves.toBe(itemC);

    await expect(resolveCliTrackedItem(runtime, {
      tool: "claude-code",
      rawModelLabel: "openai/gpt-5",
      attribution: "verified_active",
      adapterVersion: "1.0.0",
      sessionHash: "d".repeat(64),
      sessionDurationBucket: "10_30m",
      resultQualityRating: 4,
      usageEfficiencyRating: 4,
      tags: [],
      clientEventId: crypto.randomUUID()
    })).rejects.toMatchObject({ code: "model_confirmation_required" });
  });

  it("persists CLI attribution context atomically with the authoritative report", async () => {
    const userId = crypto.randomUUID();
    const installationId = crypto.randomUUID();
    const now = Date.now();
    await runtime.DB.batch([
      runtime.DB.prepare("insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Context user', ?, 1, ?, ?)").bind(userId, `${userId}@test.local`, now, now),
      runtime.DB.prepare("insert into user_profile (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at) values (?, ?, ?, ?, 'normal', 0.8, 'active', ?, ?)").bind(userId, `gh-${userId}`, `user-${userId.slice(0, 8)}`, now - 365 * 86_400_000, now - 86_400_000, now),
      runtime.DB.prepare("insert into cli_installation (id, user_id, label, token_hash, scopes_json, created_at, expires_at) values (?, ?, 'test', ?, '[\"allowance:read\",\"feedback:write\"]', ?, ?)").bind(installationId, userId, crypto.randomUUID(), now, now + 86_400_000)
    ]);
    const baseInput = command(userId, itemA);
    const input = {
      ...baseInput,
      report: { ...baseInput.report, agentItemId: itemC, resultQualityRating: 2, usageEfficiencyRating: 3 },
      cliContext: {
        installationId,
        sessionHash: "c".repeat(64),
        tool: "codex",
        rawModelLabel: "gpt-5",
        attribution: "verified_active" as const,
        adapterVersion: "0.1.0",
        sessionDurationBucket: "10_30m" as const,
        clientEventId: crypto.randomUUID()
      }
    };
    expect((await submit(input)).status).toBe(201);
    const report = await runtime.DB.prepare(
      `select r.source, r.result_quality_rating, r.usage_efficiency_rating, r.agent_item_id, c.tool, c.raw_model_label, c.session_hash
       from feedback_report r join feedback_context c on c.id = r.feedback_context_id
       where r.user_id = ? and r.idempotency_key = ?`
    ).bind(userId, input.report.idempotencyKey).first<{
      source: string; result_quality_rating: number; usage_efficiency_rating: number; agent_item_id: string; tool: string; raw_model_label: string; session_hash: string;
    }>();
    expect(report).toMatchObject({
      source: "cli",
      result_quality_rating: 2,
      usage_efficiency_rating: 3,
      agent_item_id: itemC,
      tool: "codex",
      raw_model_label: "gpt-5",
      session_hash: "c".repeat(64)
    });

    const secondItem = {
      ...command(userId, itemB),
      cliContext: {
        ...input.cliContext,
        clientEventId: crypto.randomUUID()
      }
    };
    const repeatedSession = await submit(secondItem);
    expect(repeatedSession.status).toBe(409);
    expect(repeatedSession.body.code).toBe("session_already_rated");
  });
});
