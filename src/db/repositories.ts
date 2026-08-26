import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Env } from "../env";
import { DEFAULT_SETTINGS, type AggregatePeriod, type AppSettings, type EditableFeedbackReport, type FeedbackAllowance, type ModelPageHistory, type ModelSitemapEntry, type Period, type PublicRankingPayload, type RankingItem, type UserStatus } from "../types";
import { CURRENT_SCHEMA_VERSION } from "../types";
import { getDb } from "./client";
import { aggregate, settings, trackedItem, userProfile } from "./schema";
import { calculateScores } from "../lib/scoring";
import { compareRecommendedRanking } from "../lib/ranking";
import { normalizeModelLabel } from "../lib/cli";
import { summarizeAgentContexts, type AgentContextReport } from "../lib/agent-context";
import { isGitHubUsername, isSafeHttpsUrl, isXUsername } from "../lib/security";
import { parseAppSettings } from "../lib/settings";
import { trustForAccountAge } from "../lib/trust";
import { FEEDBACK_EDIT_WINDOW_MS } from "../lib/feedback";
import { getDeletedGitHubIdentityHash } from "../lib/deleted-identity";
import { isConfiguredAdministratorGitHubId } from "../lib/administration";

const DAY_MS = 86_400_000;

interface ModelHistoryRow {
  at: number;
  overallScore: number;
  resultQualityScore: number;
  usageEfficiencyScore: number;
  confidence: number;
  reportCount: number;
}

export const getPublicModelHistory = async (env: Env, itemId: string): Promise<ModelPageHistory | null> => {
  const item = await env.DB.prepare(
    `select created_at as addedAt, updated_at as updatedAt
     from tracked_item
     where id = ? and type = 'model' and is_active = 1
     limit 1`
  ).bind(itemId).first<{ addedAt: number; updatedAt: number }>();
  if (!item) return null;

  const history = await env.DB.prepare(
    `with daily as (
       select calculated_at as at, overall_score as overallScore,
         result_quality_score as resultQualityScore,
         usage_efficiency_score as usageEfficiencyScore,
         confidence, report_count as reportCount,
         row_number() over (
           partition by cast(calculated_at / 86400000 as integer)
           order by case period when 'live' then 0 else 1 end, calculated_at desc
         ) as snapshotRank
       from aggregate
       where tracked_item_id = ? and period in ('live', '7d') and report_count > 0
     )
     select at, overallScore, resultQualityScore, usageEfficiencyScore,
       confidence, reportCount
     from daily where snapshotRank = 1 order by at asc`
  ).bind(itemId).all<ModelHistoryRow>();

  return {
    addedAt: item.addedAt,
    updatedAt: item.updatedAt,
    points: history.results.map((point) => ({
      ...point,
      overallScore: Math.round(point.overallScore),
      resultQualityScore: Math.round(point.resultQualityScore),
      usageEfficiencyScore: Math.round(point.usageEfficiencyScore),
      confidence: Math.round(point.confidence)
    }))
  };
};

export const listPublicModelSitemapEntries = async (env: Env): Promise<ModelSitemapEntry[]> => {
  const rows = await env.DB.prepare(
    `select provider_name as providerName, slug, version_label as versionLabel, updated_at as updatedAt
     from tracked_item
     where type = 'model' and is_active = 1
     order by provider_name asc, name asc`
  ).all<ModelSitemapEntry>();
  return rows.results;
};

const latestCompleteAggregateRunAt = async (
  env: Env,
  period: Period,
  activeItemCount: number,
  periodEndAtOrBefore?: number
): Promise<number | null> => {
  if (activeItemCount === 0) return null;
  const dayConstraint = periodEndAtOrBefore === undefined ? "" : "and a.snapshot_day <= ?";
  const statement = env.DB.prepare(
    `select a.calculated_at
     from aggregate a
     join tracked_item t on t.id = a.tracked_item_id and t.is_active = 1 and t.type = 'model'
     where a.period = ? ${dayConstraint}
     group by a.calculated_at
     having count(distinct a.tracked_item_id) = ?
     order by a.calculated_at desc
     limit 1`
  );
  const row = periodEndAtOrBefore === undefined
    ? await statement.bind(period, activeItemCount).first<{ calculated_at: number }>()
    : await statement.bind(period, Math.floor(periodEndAtOrBefore / DAY_MS) * DAY_MS, activeItemCount).first<{ calculated_at: number }>();
  return row?.calculated_at ?? null;
};

const getDeveloperCountsAt = async (env: Env, periodStart: number, periodEnd: number): Promise<Map<string, number>> => {
  const rows = await env.DB.prepare(
    `select tracked_item_id, count(distinct user_id) as developer_count
     from feedback_report
     where submitted_at >= ? and submitted_at <= ? and included_in_scores = 1 and moderation_status != 'excluded'
     group by tracked_item_id`
  ).bind(periodStart, periodEnd).all<{ tracked_item_id: string; developer_count: number }>();
  return new Map(rows.results.map((row) => [row.tracked_item_id, row.developer_count]));
};

export interface ProfileRecord {
  userId: string;
  githubUserId: string;
  githubUsername: string;
  githubDisplayName: string | null;
  githubAvatarUrl: string | null;
  githubAccountCreatedAt: number;
  xUsername: string | null;
  trustCategory: "blocked" | "probation" | "normal" | "trusted";
  trustWeight: number;
  status: UserStatus;
  publicProfileEnabled: boolean;
  firstLoginAt: number;
  lastLoginAt: number;
  deletedAt: number | null;
}

export const getSettings = async (env: Env): Promise<AppSettings> => {
  const db = getDb(env.DB);
  const [record] = await db.select().from(settings).where(eq(settings.key, "app")).limit(1);
  if (!record) return DEFAULT_SETTINGS;
  try {
    return parseAppSettings(JSON.parse(record.valueJson));
  } catch {
    console.error("Ignoring malformed app settings");
    return DEFAULT_SETTINGS;
  }
};

export const saveSettings = async (env: Env, value: AppSettings, actorUserId: string): Promise<void> => {
  const now = Date.now();
  const existing = await env.DB.prepare("select value_json from settings where key = 'app'").first<{ value_json: string }>();
  await env.DB.batch([
    env.DB.prepare(
    `insert into settings (key, value_json, updated_at, updated_by)
     values ('app', ?, ?, ?)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).bind(JSON.stringify(value), now, actorUserId),
    env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) values (?, ?, 'change_scoring_configuration', 'settings', 'app', ?, ?, ?)")
      .bind(crypto.randomUUID(), actorUserId, existing?.value_json ?? null, JSON.stringify(value), now)
  ]);
};

export const getProfile = async (env: Env, userId: string): Promise<ProfileRecord | null> => {
  const db = getDb(env.DB);
  const [profile] = await db.select().from(userProfile).where(eq(userProfile.userId, userId)).limit(1);
  return (profile as ProfileRecord | undefined) ?? null;
};

export const getGithubAccountId = async (env: Env, userId: string): Promise<string | null> => {
  const row = await env.DB.prepare(
    "select accountId as account_id from account where userId = ? and providerId = 'github' limit 1"
  ).bind(userId).first<{ account_id: string }>();
  return row?.account_id ?? null;
};

export const hasDeletedGitHubIdentity = async (env: Env, githubUserId: string): Promise<boolean> => {
  const identityHash = await getDeletedGitHubIdentityHash(env.DELETED_IDENTITY_SECRET, githubUserId);
  const row = await env.DB.prepare("select 1 as found from deleted_identity where identity_hash = ? limit 1")
    .bind(identityHash).first<{ found: number }>();
  return row?.found === 1;
};

const releaseReassignedGithubUsername = (env: Env, userId: string, githubUserId: string, githubUsername: string): D1PreparedStatement[] => [
  env.DB.prepare(
    `update user_profile
     set github_username = 'retired:' || github_user_id, public_profile_enabled = 0
     where user_id <> ? and github_user_id <> ? and lower(github_username) = lower(?)`
  ).bind(userId, githubUserId, githubUsername)
];

export const ensureProfile = async (args: {
  env: Env;
  userId: string;
  name: string;
  image: string | null | undefined;
  githubUserId: string;
  githubUsername: string;
  githubAccountCreatedAt: number;
  now?: number;
}): Promise<ProfileRecord> => {
  const now = args.now ?? Date.now();
  if (!args.githubUserId.trim() || !isGitHubUsername(args.githubUsername) || !Number.isFinite(args.githubAccountCreatedAt)) {
    throw new Error("Invalid GitHub identity metadata");
  }
  if (await hasDeletedGitHubIdentity(args.env, args.githubUserId)) {
    throw new Error("This GitHub identity belongs to a deleted account");
  }
  const githubAvatarUrl = args.image && isSafeHttpsUrl(args.image) ? args.image : null;
  const existing = await getProfile(args.env, args.userId);
  const githubAccountCreatedAt = existing?.githubAccountCreatedAt ?? args.githubAccountCreatedAt;
  const settings = await getSettings(args.env);
  const trust = trustForAccountAge(githubAccountCreatedAt, settings, now);
  if (existing) {
    await args.env.DB.batch([
      ...releaseReassignedGithubUsername(args.env, args.userId, args.githubUserId, args.githubUsername),
      args.env.DB.prepare(
        `update user_profile set
          github_user_id = ?, github_username = ?, github_display_name = ?, github_avatar_url = ?,
          github_account_created_at = coalesce(github_account_created_at, ?),
          trust_category = ?, trust_weight = ?,
          last_login_at = ?
         where user_id = ?`
      ).bind(args.githubUserId, args.githubUsername, args.name, githubAvatarUrl, args.githubAccountCreatedAt, trust.trustCategory, trust.trustWeight, now, args.userId)
    ]);
    return {
      ...existing,
      githubUserId: args.githubUserId,
      githubUsername: args.githubUsername,
      githubDisplayName: args.name,
      githubAvatarUrl,
      githubAccountCreatedAt,
      trustCategory: trust.trustCategory,
      trustWeight: trust.trustWeight,
      lastLoginAt: now
    };
  }

  await args.env.DB.batch([
    ...releaseReassignedGithubUsername(args.env, args.userId, args.githubUserId, args.githubUsername),
    args.env.DB.prepare(
      `insert into user_profile (
        user_id, github_user_id, github_username, github_display_name, github_avatar_url, github_account_created_at,
        trust_category, trust_weight, status, first_login_at, last_login_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(args.userId, args.githubUserId, args.githubUsername, args.name, githubAvatarUrl, args.githubAccountCreatedAt, trust.trustCategory, trust.trustWeight, now, now)
  ]);
  const profile = await getProfile(args.env, args.userId);
  if (!profile) throw new Error("Profile creation did not persist");
  return profile;
};

export const updateProfilePreferences = async (
  env: Env,
  userId: string,
  preferences: { publicProfileEnabled: boolean; xUsername: string | null }
): Promise<boolean> => {
  if (preferences.xUsername !== null && !isXUsername(preferences.xUsername)) throw new Error("Invalid X username");
  const result = await env.DB.prepare(
    "update user_profile set public_profile_enabled = ?, x_username = ? where user_id = ? and status in ('active', 'admin')"
  )
    .bind(preferences.publicProfileEnabled ? 1 : 0, preferences.xUsername, userId).run();
  return (result.meta.changes ?? 0) === 1;
};

/**
 * Remove an account's identifying and access data while retaining its minimal
 * de-identified rating records and a secret-keyed deletion marker. Optional
 * free-form report context and linkable anti-abuse identifiers are scrubbed.
 */
export const deleteOwnAccount = async (env: Env, userId: string, now = Date.now()): Promise<{ previousUsername: string }> => {
  const profile = await getProfile(env, userId);
  if (!profile || profile.status === "deleted") throw new Error("Account is already unavailable");
  if (profile.status === "admin" || isConfiguredAdministratorGitHubId(env, profile.githubUserId)) {
    throw new Error("Administrators must be demoted and removed from the allowlist before deleting their account");
  }
  const user = await env.DB.prepare("select email from user where id = ?").bind(userId).first<{ email: string }>();
  if (!user) throw new Error("Account is already unavailable");
  const tombstone = `deleted-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const deletedIdentityHash = await getDeletedGitHubIdentityHash(env.DELETED_IDENTITY_SECRET, profile.githubUserId);
  await env.DB.batch([
    env.DB.prepare("insert into deleted_identity (identity_hash, deleted_at) values (?, ?) on conflict(identity_hash) do nothing")
      .bind(deletedIdentityHash, now),
    env.DB.prepare(
      `update feedback_report set tags_json = '[]', short_comment = null,
       ip_hash = null, device_hash = null, feedback_context_id = null,
       idempotency_key = 'deleted:' || id, client_event_id = null, updated_at = ?
       where user_id = ?`
    ).bind(now, userId),
    env.DB.prepare("delete from feedback_context where user_id = ?").bind(userId),
    env.DB.prepare("delete from usage_slice where user_id = ?").bind(userId),
    env.DB.prepare("delete from quota_snapshot where user_id = ?").bind(userId),
    env.DB.prepare("delete from user_subscription where user_id = ?").bind(userId),
    env.DB.prepare("delete from cli_turnstile_challenge where user_id = ?").bind(userId),
    env.DB.prepare("delete from cli_device_authorization where user_id = ?").bind(userId),
    env.DB.prepare("delete from cli_installation where user_id = ?").bind(userId),
    env.DB.prepare("delete from risk_event where user_id = ?").bind(userId),
    env.DB.prepare("delete from session where userId = ?").bind(userId),
    env.DB.prepare("delete from account where userId = ?").bind(userId),
    env.DB.prepare("delete from verification where identifier = ?").bind(user.email),
    env.DB.prepare(
      `update audit_log set actor_user_id = null,
       before_json = case when action = 'edit_own_report' then null else before_json end,
       after_json = case when action in ('edit_own_report', 'request_catalog_candidate') then null else after_json end
       where actor_user_id = ?`
    ).bind(userId),
    env.DB.prepare(
      `update user set name = 'Deleted user', email = ?, image = null,
       githubUsername = null, githubAccountCreatedAt = null, createdAt = ?, updatedAt = ? where id = ?`
    ).bind(`${tombstone}@isaiokay.invalid`, now, now, userId),
    env.DB.prepare(
      `update user_profile set github_user_id = ?, github_username = ?, github_display_name = null,
       github_avatar_url = null, github_account_created_at = 0, x_username = null,
       trust_category = 'blocked', trust_weight = 0, status = 'deleted', public_profile_enabled = 0,
       first_login_at = ?, last_login_at = ?, deleted_at = ? where user_id = ?`
    ).bind(tombstone, tombstone, now, now, now, userId),
    env.DB.prepare(
      "insert into audit_log (id, actor_user_id, action, entity_type, entity_id, after_json, created_at) values (?, null, 'delete_own_account', 'user_profile', ?, ?, ?)"
    ).bind(crypto.randomUUID(), tombstone, JSON.stringify({ anonymized: true }), now)
  ]);
  return { previousUsername: profile.githubUsername };
};

export interface AgentOption {
  id: string;
  slug: string;
  name: string;
  providerName: string;
}

export const listActiveAgentOptions = async (env: Env): Promise<AgentOption[]> => {
  const rows = await env.DB.prepare(
    `select id, slug, name, provider_name as providerName
     from tracked_item where is_active = 1 and type = 'agent'
     order by sort_order asc, name asc`
  ).all<AgentOption>();
  return rows.results;
};

export interface PublicProfileReport {
  modelName: string;
  modelSlug: string;
  providerName: string;
  agentName: string | null;
  resultQualityRating: number;
  usageEfficiencyRating: number;
  source: "web" | "cli";
  submittedAt: number;
}

interface PublicProfileReportRow extends PublicProfileReport {
  id: string;
}

export interface PublicProfileRatingsPage {
  reports: PublicProfileReport[];
  nextCursor: string | null;
}

export const PUBLIC_PROFILE_RATINGS_PAGE_SIZE = 10;

export interface PublicProfileView {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  xUsername: string | null;
  isPublic: boolean;
  isOwner: boolean;
  reportCount: number;
  mostUsedModels: Array<{ name: string; slug: string; reports: number }>;
  reports: PublicProfileReport[];
  ratingsNextCursor: string | null;
}

export interface PublicProfileSitemapEntry {
  username: string;
  updatedAt: number;
}

const profileReportSelection = `select fr.id, ti.name as modelName, ti.slug as modelSlug, ti.provider_name as providerName,
       ai.name as agentName, fr.result_quality_rating as resultQualityRating,
       fr.usage_efficiency_rating as usageEfficiencyRating, fr.source,
       fr.submitted_at as submittedAt
     from feedback_report fr
     join tracked_item ti on ti.id = fr.tracked_item_id and ti.type = 'model'
     left join tracked_item ai on ai.id = fr.agent_item_id and ai.type = 'agent'`;

const publicProfileReportFilter = "fr.user_id = ? and fr.included_in_scores = 1 and fr.moderation_status != 'excluded'";

const decodeProfileRatingsCursor = (cursor: string): { submittedAt: number; id: string } | null => {
  const match = /^(\d{1,16}):([A-Za-z0-9_-]{1,80})$/.exec(cursor);
  if (!match) return null;
  const submittedAt = Number(match[1]);
  return Number.isSafeInteger(submittedAt) && match[2] ? { submittedAt, id: match[2] } : null;
};

export const getPublicProfileRatingsPage = async (
  env: Env,
  userId: string,
  cursor: string | null = null
): Promise<PublicProfileRatingsPage> => {
  const decodedCursor = cursor ? decodeProfileRatingsCursor(cursor) : null;
  if (cursor && !decodedCursor) return { reports: [], nextCursor: null };
  const limit = PUBLIC_PROFILE_RATINGS_PAGE_SIZE + 1;
  const query = decodedCursor
    ? `${profileReportSelection}
       where ${publicProfileReportFilter}
         and (fr.submitted_at < ? or (fr.submitted_at = ? and fr.id < ?))
       order by fr.submitted_at desc, fr.id desc limit ?`
    : `${profileReportSelection}
       where ${publicProfileReportFilter}
       order by fr.submitted_at desc, fr.id desc limit ?`;
  const statement = decodedCursor
    ? env.DB.prepare(query).bind(userId, decodedCursor.submittedAt, decodedCursor.submittedAt, decodedCursor.id, limit)
    : env.DB.prepare(query).bind(userId, limit);
  const rows = await statement.all<PublicProfileReportRow>();
  const hasMore = rows.results.length > PUBLIC_PROFILE_RATINGS_PAGE_SIZE;
  const visibleRows = rows.results.slice(0, PUBLIC_PROFILE_RATINGS_PAGE_SIZE);
  const last = visibleRows.at(-1);
  return {
    reports: visibleRows.map(({ id: _id, ...report }) => report),
    nextCursor: hasMore && last ? `${last.submittedAt}:${last.id}` : null
  };
};

export const listPublicProfileSitemapEntries = async (env: Env): Promise<PublicProfileSitemapEntry[]> => {
  const rows = await env.DB.prepare(
    `select up.github_username as username,
       max(coalesce(fr.submitted_at, up.first_login_at)) as updatedAt
     from user_profile up
     left join feedback_report fr on fr.user_id = up.user_id
       and fr.included_in_scores = 1 and fr.moderation_status != 'excluded'
     where up.public_profile_enabled = 1 and up.status in ('active', 'admin')
     group by up.user_id, up.github_username
     order by lower(up.github_username) asc`
  ).all<PublicProfileSitemapEntry>();
  return rows.results;
};

export const getPublicProfileView = async (
  env: Env,
  username: string,
  viewerUserId: string | null
): Promise<PublicProfileView | null> => {
  if (!isGitHubUsername(username)) return null;
  const profile = await env.DB.prepare(
    `select up.user_id, up.github_username, up.github_display_name, up.github_avatar_url, up.x_username, up.public_profile_enabled, up.status, u.name
     from user_profile up join user u on u.id = up.user_id
     where lower(up.github_username) = lower(?)
       and (up.status in ('active', 'admin') or up.user_id = ?)
     limit 1`
  ).bind(username, viewerUserId).first<{
    user_id: string;
    github_username: string;
    github_display_name: string | null;
    github_avatar_url: string | null;
    x_username: string | null;
    public_profile_enabled: number;
    status: string;
    name: string;
  }>();
  if (!profile?.github_username) return null;
  const isOwner = viewerUserId === profile.user_id;
  const isPublic = (profile.status === "active" || profile.status === "admin") && Boolean(profile.public_profile_enabled);
  if (!isPublic && !isOwner) return null;

  const [ratingsPage, reportCountRow, modelRows] = await Promise.all([
    getPublicProfileRatingsPage(env, profile.user_id),
    env.DB.prepare(
      `select count(*) as count from feedback_report fr
       join tracked_item ti on ti.id = fr.tracked_item_id and ti.type = 'model'
       where ${publicProfileReportFilter}`
    ).bind(profile.user_id).first<{ count: number }>(),
    env.DB.prepare(
      `select ti.name, ti.slug, count(*) as reports
       from feedback_report fr
       join tracked_item ti on ti.id = fr.tracked_item_id and ti.type = 'model'
       where ${publicProfileReportFilter}
       group by ti.id, ti.name, ti.slug
       order by reports desc, ti.name asc limit 5`
    ).bind(profile.user_id).all<{ name: string; slug: string; reports: number }>()
  ]);
  return {
    userId: profile.user_id,
    username: profile.github_username,
    displayName: profile.github_display_name ?? profile.name,
    avatarUrl: profile.github_avatar_url && isSafeHttpsUrl(profile.github_avatar_url) ? profile.github_avatar_url : null,
    xUsername: profile.x_username,
    isPublic,
    isOwner,
    reportCount: reportCountRow?.count ?? 0,
    mostUsedModels: modelRows.results,
    reports: ratingsPage.reports,
    ratingsNextCursor: ratingsPage.nextCursor
  };
};

export const getFeedbackAllowance = async (env: Env, userId: string, now = Date.now()): Promise<FeedbackAllowance> => {
  const since = now - DAY_MS;
  const rows = await env.DB.prepare(
    `select tracked_item_id, submitted_at from feedback_report
     where user_id = ? and submitted_at >= ? order by submitted_at asc`
  ).bind(userId, since).all<{ tracked_item_id: string; submitted_at: number }>();
  const reports = rows.results;
  const remaining = Math.max(0, 2 - reports.length) as FeedbackAllowance["remaining"];
  return {
    remaining,
    nextAvailableAt: reports.length >= 2 ? new Date(reports[0]!.submitted_at + DAY_MS).toISOString() : null,
    alreadyRatedItemIds: [...new Set(reports.map((report) => report.tracked_item_id))]
  };
};

const normalizeTags = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
};

export const getLatestEditableFeedbackReport = async (
  env: Env,
  userId: string,
  now = Date.now()
): Promise<EditableFeedbackReport | null> => {
  const report = await env.DB.prepare(
    `select id, tracked_item_id, agent_item_id, result_quality_rating, usage_efficiency_rating,
       tags_json, short_comment, submitted_at, edited_at
     from feedback_report where user_id = ?
     order by submitted_at desc, created_at desc, id desc limit 1`
  ).bind(userId).first<{
    id: string;
    tracked_item_id: string;
    agent_item_id: string | null;
    result_quality_rating: number;
    usage_efficiency_rating: number;
    tags_json: string;
    short_comment: string | null;
    submitted_at: number;
    edited_at: number | null;
  }>();
  if (!report || report.edited_at !== null || now >= report.submitted_at + FEEDBACK_EDIT_WINDOW_MS) return null;
  return {
    id: report.id,
    trackedItemId: report.tracked_item_id,
    agentItemId: report.agent_item_id,
    resultQualityRating: report.result_quality_rating,
    usageEfficiencyRating: report.usage_efficiency_rating,
    tags: normalizeTags(report.tags_json),
    shortComment: report.short_comment
  };
};

const topTags = (rows: Array<{ tags_json: string; result_quality_rating: number; usage_efficiency_rating: number }>, direction: "positive" | "negative"): string[] => {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const matches = direction === "positive"
      ? row.result_quality_rating >= 4 && row.usage_efficiency_rating >= 4
      : row.result_quality_rating <= 2 || row.usage_efficiency_rating <= 2;
    if (!matches) continue;
    for (const tag of normalizeTags(row.tags_json)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([tag]) => tag);
};

const buildTrend = (
  rows: Array<{
    submitted_at: number;
    result_quality_rating: number;
    usage_efficiency_rating: number;
    effective_weight: number;
    fraud_risk_score: number;
    moderation_status: string;
    included_in_scores: number;
    duplicate_cluster_adjustment: number;
  }>,
  now: number,
  appSettings: AppSettings
): RankingItem["trend"] => {
  const days = new Map<number, typeof rows>();
  for (let offset = 6; offset >= 0; offset -= 1) days.set(Math.floor((now - offset * DAY_MS) / DAY_MS) * DAY_MS, []);
  for (const row of rows) {
    const bucket = Math.floor(row.submitted_at / DAY_MS) * DAY_MS;
    days.get(bucket)?.push(row);
  }
  return [...days.entries()].flatMap(([at, reports]) => {
    if (reports.length === 0) return [];
    const score = calculateScores(reports.map((report) => ({
      submittedAt: report.submitted_at,
      resultQualityRating: report.result_quality_rating,
      usageEfficiencyRating: report.usage_efficiency_rating,
      trustWeight: report.effective_weight,
      fraudRiskScore: report.fraud_risk_score,
      moderationStatus: report.moderation_status as "pending" | "approved" | "excluded",
      includedInScores: Boolean(report.included_in_scores),
      duplicateClusterAdjustment: report.duplicate_cluster_adjustment
    })), at + DAY_MS, appSettings);
    return [{ at, score: Math.round(score.overallScore) }];
  });
};

export const getRankingFromD1 = async (env: Env, period: Period, now = Date.now()): Promise<PublicRankingPayload> => {
  const db = getDb(env.DB);
  const items = await db.select().from(trackedItem)
    .where(and(eq(trackedItem.isActive, true), eq(trackedItem.type, "model")))
    .orderBy(asc(trackedItem.sortOrder), asc(trackedItem.name));
  const appSettings = await getSettings(env);
  const periodLength = period === "live" ? appSettings.liveScoreLookbackDays * DAY_MS : period === "24h" ? DAY_MS : 7 * DAY_MS;
  const snapshotAt = await latestCompleteAggregateRunAt(env, period, items.length);
  const asOf = snapshotAt ?? now;
  const periodStart = asOf - periodLength;
  const previousSnapshotAt = snapshotAt === null
    ? null
    : await latestCompleteAggregateRunAt(env, period, items.length, period === "live" ? asOf - DAY_MS : periodStart);
  const rankings: RankingItem[] = [];
  const previousSignals = new Map<string, Pick<RankingItem, "name" | "overallScore" | "confidence" | "developerCount" | "possibleDegradationSinceRelease" | "reportCount">>();
  const developerCounts = await getDeveloperCountsAt(env, periodStart, asOf);
  const previousDeveloperCounts = previousSnapshotAt === null
    ? new Map<string, number>()
    : await getDeveloperCountsAt(env, previousSnapshotAt - periodLength, previousSnapshotAt);
  const agentContextRows = await env.DB.prepare(
    `select fr.tracked_item_id as trackedItemId, ai.id as agentId, ai.name as agentName,
       fr.user_id as userId, fr.submitted_at as submittedAt,
       fr.result_quality_rating as resultQualityRating,
       fr.usage_efficiency_rating as usageEfficiencyRating,
       fr.effective_weight as trustWeight,
       fr.fraud_risk_score as fraudRiskScore, fr.moderation_status as moderationStatus,
       fr.included_in_scores as includedInScores,
       fr.duplicate_cluster_adjustment as duplicateClusterAdjustment
     from feedback_report fr
     join tracked_item ai on ai.id = fr.agent_item_id and ai.type = 'agent'
     where fr.submitted_at >= ? and fr.submitted_at <= ?`
  ).bind(periodStart, asOf).all<AgentContextReport & { trackedItemId: string }>();
  const agentContextsByItem = new Map<string, AgentContextReport[]>();
  for (const row of agentContextRows.results) {
    const group = agentContextsByItem.get(row.trackedItemId) ?? [];
    group.push({ ...row, includedInScores: Boolean(row.includedInScores) });
    agentContextsByItem.set(row.trackedItemId, group);
  }

  for (const item of items) {
    const [latest] = snapshotAt === null ? [] : await db.select().from(aggregate)
      .where(and(eq(aggregate.trackedItemId, item.id), eq(aggregate.period, period), eq(aggregate.calculatedAt, snapshotAt)))
      .limit(1);
    const [baseline] = await db.select().from(aggregate)
      .where(and(eq(aggregate.trackedItemId, item.id), eq(aggregate.period, "release_baseline")))
      .orderBy(desc(aggregate.calculatedAt)).limit(1);
    const [previous] = previousSnapshotAt === null ? [] : await db.select().from(aggregate)
      .where(and(eq(aggregate.trackedItemId, item.id), eq(aggregate.period, period), eq(aggregate.calculatedAt, previousSnapshotAt)))
      .limit(1);
    const tagRows = await env.DB.prepare(
      `select tags_json, result_quality_rating, usage_efficiency_rating from feedback_report
       where tracked_item_id = ? and submitted_at >= ? and submitted_at <= ? and included_in_scores = 1 and moderation_status != 'excluded'`
    ).bind(item.id, asOf - 7 * DAY_MS, asOf).all<{ tags_json: string; result_quality_rating: number; usage_efficiency_rating: number }>();
    const trendRows = await env.DB.prepare(
      `select submitted_at, result_quality_rating, usage_efficiency_rating,
        effective_weight, fraud_risk_score, moderation_status, included_in_scores, duplicate_cluster_adjustment
       from feedback_report
       where tracked_item_id = ? and submitted_at >= ? and submitted_at <= ? and included_in_scores = 1 and moderation_status != 'excluded'`
    ).bind(item.id, asOf - 7 * DAY_MS, asOf).all<{
      submitted_at: number; result_quality_rating: number; usage_efficiency_rating: number;
      effective_weight: number; fraud_risk_score: number; moderation_status: string; included_in_scores: number;
      duplicate_cluster_adjustment: number;
    }>();
    const baselineQualified = Boolean(
      baseline
      && baseline.reportCount >= appSettings.releaseBaselineMinReports
      && baseline.confidence >= appSettings.releaseBaselineMinConfidence
    );
    const resultQualityChangeSinceRelease = latest && baselineQualified && baseline
      ? Math.round((latest.resultQualityScore - baseline.resultQualityScore) * 10) / 10
      : null;
    const resultQualityChangeVsPrevious = latest && previous ? Math.round((latest.resultQualityScore - previous.resultQualityScore) * 10) / 10 : 0;
    const baselineWindowEnd = item.baselineEndAt ?? (item.releaseAt ? item.releaseAt + 48 * 60 * 60_000 + 7 * DAY_MS : null);
    const baselineEvidenceStatus: RankingItem["baselineEvidenceStatus"] = baselineQualified
      ? "available"
      : item.releaseAt && baselineWindowEnd && asOf < baselineWindowEnd
        ? "collecting"
        : item.releaseAt
          ? "insufficient_evidence"
          : "no_release_baseline";
    const possibleDegradationSinceRelease = Boolean(
      resultQualityChangeSinceRelease !== null
      && resultQualityChangeSinceRelease <= appSettings.releaseDegradationThreshold
      && resultQualityChangeVsPrevious <= appSettings.degradingThreshold
      && (latest?.confidence ?? 0) >= appSettings.possibleDegradationMinimumConfidence
    );
    if (previous) {
      const priorToPrevious = await latestAggregateBefore(
        env,
        item.id,
        period,
        period === "live" ? previous.periodEnd - DAY_MS : previous.periodStart
      );
      const previousBaselineQualified = Boolean(
        baseline
        && baseline.calculatedAt <= previous.periodEnd
        && baseline.reportCount >= appSettings.releaseBaselineMinReports
        && baseline.confidence >= appSettings.releaseBaselineMinConfidence
      );
      const previousResultQualitySinceRelease = previousBaselineQualified && baseline
        ? previous.resultQualityScore - baseline.resultQualityScore
        : null;
      const previousResultQualityChange = priorToPrevious ? previous.resultQualityScore - priorToPrevious.resultQualityScore : 0;
      previousSignals.set(item.id, {
        name: item.name,
        overallScore: previous.overallScore,
        confidence: previous.confidence,
        developerCount: previousDeveloperCounts.get(item.id) ?? 0,
        possibleDegradationSinceRelease: Boolean(
          previousResultQualitySinceRelease !== null
          && previousResultQualitySinceRelease <= appSettings.releaseDegradationThreshold
          && previousResultQualityChange <= appSettings.degradingThreshold
          && previous.confidence >= appSettings.possibleDegradationMinimumConfidence
        ),
        reportCount: previous.reportCount
      });
    }
    rankings.push({
      id: item.id,
      name: item.name,
      slug: item.slug,
      providerName: item.providerName,
      type: item.type,
      description: item.description,
      logoUrl: item.logoUrl,
      officialUrl: isSafeHttpsUrl(item.officialUrl) ? item.officialUrl : null,
      pricingSummary: item.pricingSummary,
      pricingLastVerifiedAt: item.pricingLastVerifiedAt,
      versionLabel: item.versionLabel,
      releaseAt: item.releaseAt,
      releaseSourceUrl: item.releaseSourceUrl && isSafeHttpsUrl(item.releaseSourceUrl) ? item.releaseSourceUrl : null,
      overallScore: latest ? Math.round(latest.overallScore) : 0,
      resultQualityScore: latest ? Math.round(latest.resultQualityScore) : 0,
      usageEfficiencyScore: latest ? Math.round(latest.usageEfficiencyScore) : 0,
      confidence: latest ? Math.round(latest.confidence) : 0,
      reportCount: latest?.reportCount ?? 0,
      developerCount: developerCounts.get(item.id) ?? 0,
      rankChange: null,
      change: latest ? Math.round(latest.change * 10) / 10 : 0,
      resultQualityChangeVsPrevious,
      releaseBaselineResultQuality: baselineQualified && baseline ? Math.round(baseline.resultQualityScore) : null,
      resultQualityChangeSinceRelease,
      baselineEvidenceStatus,
      possibleDegradationSinceRelease,
      state: latest?.state ?? "new",
      calculatedAt: latest?.calculatedAt ?? asOf,
      positiveTags: topTags(tagRows.results, "positive"),
      complaintTags: topTags(tagRows.results, "negative"),
      trend: buildTrend(trendRows.results, asOf, appSettings),
      agentContexts: summarizeAgentContexts(agentContextsByItem.get(item.id) ?? [], asOf, appSettings, period === "live")
    });
  }

  rankings.sort(compareRecommendedRanking);
  const previousRanks = new Map(
    [...previousSignals.entries()]
      .filter(([, item]) => item.reportCount > 0)
      .sort(([, left], [, right]) => compareRecommendedRanking(left, right))
      .map(([itemId], index) => [itemId, index + 1])
  );
  rankings.forEach((item, currentIndex) => {
    const previousRank = previousRanks.get(item.id);
    item.rankChange = item.reportCount > 0 && previousRank !== undefined ? previousRank - (currentIndex + 1) : null;
  });
  const total = await env.DB.prepare(
    "select count(*) as count from feedback_report where submitted_at >= ? and submitted_at <= ? and included_in_scores = 1 and moderation_status != 'excluded'"
  ).bind(periodStart, asOf).first<{ count: number }>();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    period,
    generatedAt: new Date(asOf).toISOString(),
    expiresAt: new Date(asOf + 10 * 60_000).toISOString(),
    items: rankings,
    totalReports: total?.count ?? 0
  };
};

export interface AdminReport {
  id: string;
  itemName: string;
  itemSlug: string;
  userId: string;
  resultQualityRating: number;
  usageEfficiencyRating: number;
  shortComment: string | null;
  tagsJson: string;
  moderationStatus: string;
  fraudRiskScore: number;
  submittedAt: number;
  source: "web" | "cli";
  tool: string | null;
  rawModelLabel: string | null;
  attribution: string | null;
}

export const listAdminReports = async (env: Env, status?: string): Promise<AdminReport[]> => {
  const where = status ? "where r.moderation_status = ?" : "";
  const statement = env.DB.prepare(
    `select r.id, i.name as item_name, i.slug as item_slug, r.user_id,
      r.result_quality_rating, r.usage_efficiency_rating,
      r.short_comment, r.tags_json, r.moderation_status,
      r.fraud_risk_score, r.submitted_at, r.source,
      c.tool, c.raw_model_label, c.attribution
      from feedback_report r join tracked_item i on i.id = r.tracked_item_id
      left join feedback_context c on c.id = r.feedback_context_id ${where}
      order by r.submitted_at desc limit 100`
  );
  const result = status ? await statement.bind(status).all<Record<string, unknown>>() : await statement.all<Record<string, unknown>>();
  return result.results.map((row) => ({
    id: String(row.id), itemName: String(row.item_name), itemSlug: String(row.item_slug), userId: String(row.user_id),
    resultQualityRating: Number(row.result_quality_rating), usageEfficiencyRating: Number(row.usage_efficiency_rating),
    shortComment: row.short_comment === null ? null : String(row.short_comment), tagsJson: String(row.tags_json), moderationStatus: String(row.moderation_status),
    fraudRiskScore: Number(row.fraud_risk_score), submittedAt: Number(row.submitted_at),
    source: row.source === "cli" ? "cli" : "web",
    tool: row.tool === null ? null : String(row.tool),
    rawModelLabel: row.raw_model_label === null ? null : String(row.raw_model_label),
    attribution: row.attribution === null ? null : String(row.attribution)
  }));
};

export const setReportModeration = async (args: {
  env: Env;
  reportId: string;
  status: "pending" | "approved" | "excluded";
  actorUserId: string;
}): Promise<void> => {
  const before = await args.env.DB.prepare("select moderation_status, included_in_scores from feedback_report where id = ?").bind(args.reportId)
    .first<{ moderation_status: string; included_in_scores: number }>();
  if (!before) throw new Error("Report not found");
  const included = args.status !== "excluded" ? 1 : 0;
  const now = Date.now();
  await args.env.DB.batch([
    args.env.DB.prepare("update feedback_report set moderation_status = ?, included_in_scores = ?, updated_at = ? where id = ?")
      .bind(args.status, included, now, args.reportId),
    args.env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), args.actorUserId, args.status === "excluded" ? "exclude_report" : "restore_report", "feedback_report", args.reportId, JSON.stringify(before), JSON.stringify({ moderationStatus: args.status, includedInScores: Boolean(included) }), now)
  ]);
};

export const setUserStatus = async (args: { env: Env; userId: string; status: Exclude<UserStatus, "deleted">; actorUserId: string }): Promise<void> => {
  const before = await getProfile(args.env, args.userId);
  if (!before) throw new Error("User profile not found");
  if (before.status === "deleted") throw new Error("Deleted accounts cannot be reactivated");
  const now = Date.now();
  await args.env.DB.batch([
    args.env.DB.prepare("update user_profile set status = ? where user_id = ?")
      .bind(args.status, args.userId),
    args.env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) values (?, ?, 'change_user_status', 'user_profile', ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), args.actorUserId, args.userId, JSON.stringify({ status: before.status }), JSON.stringify({ status: args.status }), now)
  ]);
};

export const upsertTrackedItem = async (env: Env, item: {
  id?: string;
  name: string;
  slug: string;
  providerName: string;
  type: "model" | "agent";
  description?: string;
  officialUrl: string;
  pricingSummary?: string;
  versionLabel?: string | null;
  releaseAt?: number | null;
  releaseSourceUrl?: string | null;
  sortOrder?: number;
}, actorUserId: string): Promise<void> => {
  if (!isSafeHttpsUrl(item.officialUrl)) throw new Error("A credential-free HTTPS official URL is required");
  if (item.releaseSourceUrl && !isSafeHttpsUrl(item.releaseSourceUrl)) throw new Error("A credential-free HTTPS release source is required");
  const now = Date.now();
  const id = item.id ?? crypto.randomUUID();
  const before = item.id
    ? await env.DB.prepare("select release_at, version_label, release_source_url from tracked_item where id = ?").bind(id)
      .first<{ release_at: number | null; version_label: string | null; release_source_url: string | null }>()
    : null;
  const nextReleaseAt = item.releaseAt === undefined ? (before?.release_at ?? null) : item.releaseAt;
  const nextVersionLabel = item.versionLabel === undefined ? (before?.version_label ?? null) : item.versionLabel;
  const nextReleaseSourceUrl = item.releaseSourceUrl === undefined ? (before?.release_source_url ?? null) : item.releaseSourceUrl;
  const releaseChanged = Boolean(before && (
    before.release_at !== nextReleaseAt
    || before.version_label !== nextVersionLabel
    || before.release_source_url !== nextReleaseSourceUrl
  ));
  const statements = [
    env.DB.prepare(
      `insert into tracked_item (
        id, name, slug, provider_name, type, description, official_url, pricing_summary,
        version_label, release_at, release_source_url, is_active, sort_order, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       on conflict(id) do update set name = excluded.name, slug = excluded.slug, provider_name = excluded.provider_name, type = excluded.type,
       description = excluded.description, official_url = excluded.official_url, pricing_summary = excluded.pricing_summary,
       version_label = excluded.version_label, release_at = excluded.release_at, release_source_url = excluded.release_source_url,
       baseline_start_at = case when tracked_item.release_at is not excluded.release_at or tracked_item.version_label is not excluded.version_label then null else tracked_item.baseline_start_at end,
       baseline_end_at = case when tracked_item.release_at is not excluded.release_at or tracked_item.version_label is not excluded.version_label then null else tracked_item.baseline_end_at end,
       baseline_locked_at = case when tracked_item.release_at is not excluded.release_at or tracked_item.version_label is not excluded.version_label then null else tracked_item.baseline_locked_at end,
       baseline_method_version = case when tracked_item.release_at is not excluded.release_at or tracked_item.version_label is not excluded.version_label then null else tracked_item.baseline_method_version end,
       sort_order = excluded.sort_order, updated_at = excluded.updated_at`
    ).bind(
      id, item.name, item.slug, item.providerName, item.type, item.description ?? null, item.officialUrl,
      item.pricingSummary ?? null, nextVersionLabel, nextReleaseAt, nextReleaseSourceUrl,
      item.sortOrder ?? 0, now, now
    ),
    env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, after_json, created_at) values (?, ?, 'edit_tracked_item', 'tracked_item', ?, ?, ?)")
      .bind(crypto.randomUUID(), actorUserId, id, JSON.stringify(item), now)
  ];
  if (releaseChanged) statements.push(env.DB.prepare("delete from aggregate where tracked_item_id = ? and period = 'release_baseline'").bind(id));
  await env.DB.batch(statements);
};

export interface CatalogCandidateInput {
  name: string;
  providerName: string;
  type: "model" | "agent";
  source: "provider_release" | "reddit" | "cli" | "admin";
  sourceUrl: string | null;
  rawLabel: string | null;
  versionLabel: string | null;
  releaseAt: number | null;
  provenance: { source: string; url: string | null; seenAt: number; detail: string | null };
}

export interface CatalogCandidateRecord {
  id: string;
  name: string;
  normalizedKey: string;
  providerName: string;
  type: "model" | "agent";
  source: "provider_release" | "reddit" | "cli" | "admin";
  sourceUrl: string | null;
  rawLabel: string | null;
  versionLabel: string | null;
  releaseAt: number | null;
  provenance: Array<{ source: string; url: string | null; seenAt: number; detail: string | null }>;
  status: "pending" | "promoted" | "dismissed";
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
}

const parseProvenance = (value: string): CatalogCandidateRecord["provenance"] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): CatalogCandidateRecord["provenance"] => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.source !== "string" || typeof record.seenAt !== "number" || !Number.isFinite(record.seenAt)) return [];
      const url = typeof record.url === "string" && isSafeHttpsUrl(record.url) ? record.url : null;
      return [{
        source: record.source.slice(0, 40),
        url,
        seenAt: record.seenAt,
        detail: typeof record.detail === "string" ? record.detail.slice(0, 200) : null
      }];
    });
  } catch {
    return [];
  }
};

/**
 * Nomination-only upsert. Deduplication uses a normalized provider + name key,
 * so repeated social mentions increment the seen count instead of spawning
 * duplicates. A candidate never creates scores, aggregates, or rankings.
 */
export const upsertCatalogCandidate = async (
  env: Env,
  input: CatalogCandidateInput,
  now = Date.now(),
  maxProvenance = 10
): Promise<boolean> => {
  const sourceUrl = input.sourceUrl && isSafeHttpsUrl(input.sourceUrl) ? input.sourceUrl : null;
  const provenance = {
    ...input.provenance,
    url: input.provenance.url && isSafeHttpsUrl(input.provenance.url) ? input.provenance.url : null
  };
  const normalizedKey = `${normalizeModelLabel(input.providerName)}-${normalizeModelLabel(input.name)}`;
  const existing = await env.DB.prepare(
    "select id, provenance_json, seen_count from catalog_candidate where normalized_key = ?"
  ).bind(normalizedKey).first<{ id: string; provenance_json: string; seen_count: number }>();
  if (existing) {
    const nextProvenance = [...parseProvenance(existing.provenance_json), provenance].slice(-maxProvenance);
    await env.DB.prepare(
      `update catalog_candidate set
        name = ?, provider_name = ?, source = ?, source_url = ?, raw_label = ?,
        version_label = coalesce(?, version_label), release_at = coalesce(?, release_at),
        provenance_json = ?, last_seen_at = ?, seen_count = ?, updated_at = ?
       where id = ?`
    ).bind(
      input.name, input.providerName, input.source, sourceUrl, input.rawLabel,
      input.versionLabel, input.releaseAt, JSON.stringify(nextProvenance), now, existing.seen_count + 1, now, existing.id
    ).run();
    return false;
  }
  await env.DB.prepare(
    `insert into catalog_candidate (
      id, name, normalized_key, provider_name, type, source, source_url, raw_label,
      version_label, release_at, provenance_json, status, first_seen_at, last_seen_at,
      seen_count, created_at, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?)`
  ).bind(
    crypto.randomUUID(), input.name, normalizedKey, input.providerName, input.type, input.source,
    sourceUrl, input.rawLabel, input.versionLabel, input.releaseAt,
    JSON.stringify([provenance]), now, now, now, now
  ).run();
  return true;
};

export const listCatalogCandidates = async (env: Env, status?: "pending" | "promoted" | "dismissed"): Promise<CatalogCandidateRecord[]> => {
  const where = status === undefined ? "" : "where status = ?";
  const statement = env.DB.prepare(
    `select id, name, normalized_key as normalizedKey, provider_name as providerName, type, source,
       source_url as sourceUrl, raw_label as rawLabel, version_label as versionLabel,
       release_at as releaseAt, provenance_json as provenanceJson, status,
       first_seen_at as firstSeenAt, last_seen_at as lastSeenAt, seen_count as seenCount
     from catalog_candidate ${where}
     order by last_seen_at desc limit 200`
  );
  const rows = status === undefined ? await statement.all<Record<string, unknown>>() : await statement.bind(status).all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    id: String(row.id), name: String(row.name), normalizedKey: String(row.normalizedKey),
    providerName: String(row.providerName), type: row.type === "agent" ? "agent" as const : "model" as const,
    source: String(row.source) as CatalogCandidateRecord["source"],
    sourceUrl: row.sourceUrl !== null && isSafeHttpsUrl(String(row.sourceUrl)) ? String(row.sourceUrl) : null,
    rawLabel: row.rawLabel === null ? null : String(row.rawLabel),
    versionLabel: row.versionLabel === null ? null : String(row.versionLabel),
    releaseAt: row.releaseAt === null ? null : Number(row.releaseAt),
    provenance: parseProvenance(String(row.provenanceJson)),
    status: String(row.status) as CatalogCandidateRecord["status"],
    firstSeenAt: Number(row.firstSeenAt), lastSeenAt: Number(row.lastSeenAt), seenCount: Number(row.seenCount)
  }));
};

const uniqueCandidateSlug = async (env: Env, preferred: string): Promise<string> => {
  const base = normalizeModelLabel(preferred) || "model";
  const candidates = [base, `${base}-${normalizeModelLabel(crypto.randomUUID().slice(0, 8))}`];
  for (const slug of candidates) {
    const existing = await env.DB.prepare("select id from tracked_item where slug = ?").bind(slug).first<{ id: string }>();
    if (!existing) return slug;
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
};

/**
 * The curation boundary: only an administrator can promote a candidate, and
 * promotion requires an official URL. The new `tracked_item` starts at
 * `Pending` with no score, developer count, movement, or trend.
 */
export const promoteCatalogCandidate = async (args: {
  env: Env;
  candidateId: string;
  actorUserId: string;
  overrides: {
    officialUrl: string;
    name?: string;
    providerName?: string;
    type?: "model" | "agent";
    description?: string;
    versionLabel?: string | null;
    releaseAt?: number | null;
    releaseSourceUrl?: string | null;
  };
  now?: number;
}): Promise<{ trackedItemId: string; slug: string }> => {
  const now = args.now ?? Date.now();
  const candidate = await args.env.DB.prepare(
    "select * from catalog_candidate where id = ?"
  ).bind(args.candidateId).first<Record<string, unknown>>();
  if (!candidate) throw new Error("Catalog candidate not found");
  if (candidate.status !== "pending") throw new Error("Only pending catalog candidates can be promoted");
  const officialUrl = args.overrides.officialUrl.trim();
  if (!isSafeHttpsUrl(officialUrl)) throw new Error("A credential-free HTTPS official URL is required to promote a candidate");
  const name = (args.overrides.name ?? String(candidate.name)).slice(0, 80);
  const providerName = (args.overrides.providerName ?? String(candidate.provider_name)).slice(0, 80);
  const type = args.overrides.type ?? (candidate.type === "agent" ? "agent" : "model");
  const slug = await uniqueCandidateSlug(args.env, args.overrides.name ?? String(candidate.name));
  const candidateProvenance = parseProvenance(String(candidate.provenance_json ?? "[]"));
  const officialReleaseSource = [...candidateProvenance].reverse().find((entry) => entry.source === "provider_release" && entry.url)?.url ?? null;
  const versionLabel = args.overrides.versionLabel === undefined ? (candidate.version_label === null ? null : String(candidate.version_label)) : args.overrides.versionLabel;
  const candidateReleaseAt = candidate.release_at === null ? null : Number(candidate.release_at);
  const releaseAt = args.overrides.releaseAt === undefined ? (officialReleaseSource ? candidateReleaseAt : null) : args.overrides.releaseAt;
  const releaseSourceUrl = args.overrides.releaseSourceUrl === undefined ? (candidateReleaseAt ? officialReleaseSource : null) : args.overrides.releaseSourceUrl;
  if ((releaseAt === null) !== (releaseSourceUrl === null)) throw new Error("Release date and official release source must be provided together");
  if (releaseSourceUrl && !isSafeHttpsUrl(releaseSourceUrl)) throw new Error("A credential-free HTTPS release source is required");
  const trackedItemId = crypto.randomUUID();
  await args.env.DB.batch([
    args.env.DB.prepare(
      `insert into tracked_item (
        id, name, slug, provider_name, type, description, official_url, pricing_summary,
        version_label, release_at, release_source_url, is_active, sort_order, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, 1, 0, ?, ?)`
    ).bind(trackedItemId, name, slug, providerName, type, args.overrides.description ?? null, officialUrl, versionLabel, releaseAt, releaseSourceUrl, now, now),
    args.env.DB.prepare("update catalog_candidate set status = 'promoted', updated_at = ? where id = ? and status = 'pending'").bind(now, args.candidateId),
    args.env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) values (?, ?, 'promote_catalog_candidate', 'catalog_candidate', ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), args.actorUserId, args.candidateId, JSON.stringify({ status: "pending" }), JSON.stringify({ status: "promoted", trackedItemId, slug }), now)
  ]);
  return { trackedItemId, slug };
};

export const dismissCatalogCandidate = async (args: {
  env: Env;
  candidateId: string;
  actorUserId: string;
  now?: number;
}): Promise<void> => {
  const now = args.now ?? Date.now();
  const candidate = await args.env.DB.prepare("select status from catalog_candidate where id = ?").bind(args.candidateId).first<{ status: string }>();
  if (!candidate) throw new Error("Catalog candidate not found");
  await args.env.DB.batch([
    args.env.DB.prepare("update catalog_candidate set status = 'dismissed', updated_at = ? where id = ?").bind(now, args.candidateId),
    args.env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at) values (?, ?, 'dismiss_catalog_candidate', 'catalog_candidate', ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), args.actorUserId, args.candidateId, JSON.stringify({ status: candidate.status }), JSON.stringify({ status: "dismissed" }), now)
  ]);
};

export const getActiveItemById = async (env: Env, itemId: string): Promise<{ id: string; isActive: boolean; type: "model" | "agent" } | null> => {
  const db = getDb(env.DB);
  const [item] = await db.select({ id: trackedItem.id, isActive: trackedItem.isActive, type: trackedItem.type }).from(trackedItem).where(eq(trackedItem.id, itemId)).limit(1);
  return item ?? null;
};

export const getItemBySlug = async (env: Env, slug: string): Promise<RankingItem | null> => {
  const payload = await getRankingFromD1(env, "live");
  return payload.items.find((item) => item.slug === slug) ?? null;
};

export const reportCountSince = async (env: Env, userId: string, since: number): Promise<number> => {
  const result = await env.DB.prepare("select count(*) as count from feedback_report where user_id = ? and submitted_at >= ?").bind(userId, since).first<{ count: number }>();
  return result?.count ?? 0;
};

export const getSuspicion = async (env: Env, userId: string, now = Date.now()): Promise<boolean> => {
  const result = await env.DB.prepare("select count(*) as count from risk_event where user_id = ? and expires_at > ? and score >= 0.7")
    .bind(userId, now).first<{ count: number }>();
  return (result?.count ?? 0) > 0;
};

export const getDuplicateClusterSignal = async (
  env: Env,
  userId: string,
  ipHash: string,
  deviceHash: string,
  since: number
): Promise<{ adjustment: number; suspicious: boolean }> => {
  const [device, ip] = await Promise.all([
    env.DB.prepare(
      "select count(distinct user_id) as users from feedback_report where user_id != ? and device_hash = ? and submitted_at >= ?"
    ).bind(userId, deviceHash, since).first<{ users: number }>(),
    env.DB.prepare(
      "select count(distinct user_id) as users from feedback_report where user_id != ? and ip_hash = ? and submitted_at >= ?"
    ).bind(userId, ipHash, since).first<{ users: number }>()
  ]);
  const deviceUsers = device?.users ?? 0;
  const ipUsers = ip?.users ?? 0;
  const deviceAdjustment = deviceUsers >= 3 ? 0.4 : deviceUsers >= 2 ? 0.6 : deviceUsers >= 1 ? 0.8 : 1;
  const ipAdjustment = ipUsers >= 5 ? 0.5 : ipUsers >= 3 ? 0.75 : 1;
  return {
    adjustment: Math.min(deviceAdjustment, ipAdjustment),
    suspicious: deviceUsers >= 2 || ipUsers >= 5
  };
};

export const archiveExpiredRiskData = async (env: Env, now = Date.now()): Promise<void> => {
  const appSettings = await getSettings(env);
  const riskCutoff = now - appSettings.riskRetentionDays * DAY_MS;
  await env.DB.batch([
    env.DB.prepare("delete from risk_event where expires_at < ?").bind(now),
    env.DB.prepare("delete from cli_device_authorization where expires_at < ?").bind(now - DAY_MS),
    env.DB.prepare(
      `update feedback_report set ip_hash = null, device_hash = null, updated_at = ?
       where submitted_at < ? and (ip_hash is not null or device_hash is not null)`
    ).bind(now, riskCutoff)
  ]);
};

export const getReportsForAggregation = async (env: Env, itemId: string, start: number, end: number) => {
  const result = await env.DB.prepare(
    `select id, submitted_at, result_quality_rating, usage_efficiency_rating,
      effective_weight, fraud_risk_score, moderation_status, included_in_scores, duplicate_cluster_adjustment, user_id
      from feedback_report where tracked_item_id = ? and submitted_at >= ? and submitted_at < ?`
  ).bind(itemId, start, end).all<{
    id: string; submitted_at: number; result_quality_rating: number; usage_efficiency_rating: number;
    effective_weight: number; fraud_risk_score: number; moderation_status: string; included_in_scores: number;
    duplicate_cluster_adjustment: number; user_id: string;
  }>();
  return result.results;
};

export const allActiveItems = async (env: Env) => {
  const db = getDb(env.DB);
  return db.select().from(trackedItem).where(and(eq(trackedItem.isActive, true), eq(trackedItem.type, "model")));
};

export const latestAggregateBefore = async (env: Env, itemId: string, period: AggregatePeriod, before: number) => {
  const db = getDb(env.DB);
  const snapshotDay = Math.floor(before / DAY_MS) * DAY_MS;
  const [record] = await db.select().from(aggregate)
    .where(and(eq(aggregate.trackedItemId, itemId), eq(aggregate.period, period), sql`${aggregate.snapshotDay} <= ${snapshotDay}`))
    .orderBy(desc(aggregate.snapshotDay)).limit(1);
  return record ?? null;
};

const aggregateUpsert = (env: Env, values: typeof aggregate.$inferInsert): D1PreparedStatement => env.DB.prepare(
  `insert into aggregate (
    id, tracked_item_id, period, period_start, period_end, report_count,
    weighted_report_count, overall_score, result_quality_score,
    usage_efficiency_score, confidence, change, state, snapshot_day, calculated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(tracked_item_id, period, snapshot_day) do update set
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    report_count = excluded.report_count,
    weighted_report_count = excluded.weighted_report_count,
    overall_score = excluded.overall_score,
    result_quality_score = excluded.result_quality_score,
    usage_efficiency_score = excluded.usage_efficiency_score,
    confidence = excluded.confidence,
    change = excluded.change,
    state = excluded.state,
    calculated_at = excluded.calculated_at`
).bind(
  values.id,
  values.trackedItemId,
  values.period,
  values.periodStart,
  values.periodEnd,
  values.reportCount,
  values.weightedReportCount,
  values.overallScore,
  values.resultQualityScore,
  values.usageEfficiencyScore,
  values.confidence,
  values.change,
  values.state,
  values.snapshotDay,
  values.calculatedAt
);

/** A period becomes visible atomically, so readers never observe a partial model set. */
export const saveAggregates = async (env: Env, values: Array<typeof aggregate.$inferInsert>): Promise<void> => {
  if (values.length === 0) return;
  await env.DB.batch(values.map((value) => aggregateUpsert(env, value)));
};

export const saveAggregate = async (env: Env, values: typeof aggregate.$inferInsert): Promise<void> => {
  await saveAggregates(env, [values]);
};
