import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";
import { archiveExpiredRiskData, ensureProfile, getFeedbackAllowance, getPublicProfileRatingsPage, getPublicProfileView, getRankingFromD1, latestAggregateBefore, updateProfilePreferences } from "../../src/db/repositories";
import { loadPublicRanking } from "../../src/lib/cache";
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

const submit = async (input: ReturnType<typeof command>) => {
  const stub = runtime.FEEDBACK_ALLOWANCE.get(runtime.FEEDBACK_ALLOWANCE.idFromName(input.userId));
  const response = await stub.fetch("https://allowance/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() as { accepted: boolean; idempotent: boolean; code?: string; allowance: { remaining: number; alreadyRatedItemIds: string[] } } };
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
    expect(authenticated).toMatchObject({ userId, scopes: ["allowance:read", "feedback:write"] });

    const headless = await startDeviceAuthorization(runtime, "headless-cli", now + 3);
    await approveDeviceAuthorization(runtime, authenticated, headless.userCode, now + 4);
    const headlessToken = await exchangeDeviceAuthorization(runtime, headless.deviceCode, now + 5);
    const headlessIdentity = await requireCliIdentity(new Request("https://isaiokay.test/api/cli/allowance", {
      headers: { authorization: `Bearer ${headlessToken.accessToken}` }
    }), runtime, "allowance:read");
    expect(headlessIdentity).toMatchObject({ userId, scopes: ["allowance:read", "feedback:write"] });
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
