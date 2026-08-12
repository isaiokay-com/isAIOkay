import type { Env } from "../../src/env";

/** Minimal migration slice for Workers integration tests. Production uses Drizzle's migration SQL. */
export const prepareTestDatabase = async (env: Env): Promise<void> => {
  await env.DB.exec(`
    create table if not exists user (id text primary key, name text not null, email text not null unique, emailVerified integer not null, image text, githubUsername text, githubAccountCreatedAt integer, createdAt integer not null, updatedAt integer not null);
    create table if not exists user_profile (user_id text primary key, github_user_id text not null unique, github_username text not null, github_display_name text, github_avatar_url text, github_account_created_at integer not null, x_username text, trust_category text not null, trust_weight real not null, status text not null, public_profile_enabled integer not null default 0, first_login_at integer not null, last_login_at integer not null, deleted_at integer);
    create unique index if not exists user_profile_github_username_unique on user_profile(lower(github_username));
    create table if not exists tracked_item (id text primary key, name text not null, slug text not null unique, provider_name text not null, type text not null, description text, logo_url text, official_url text not null, pricing_summary text, pricing_last_verified_at integer, version_label text, release_at integer, baseline_start_at integer, baseline_end_at integer, baseline_locked_at integer, baseline_method_version text, release_source_url text, is_active integer not null default 1, sort_order integer not null default 0, created_at integer not null, updated_at integer not null);
    create table if not exists cli_device_authorization (id text primary key, device_code_hash text not null unique, user_code text not null unique, status text not null default 'pending', user_id text, client_name text not null, created_at integer not null, expires_at integer not null, approved_at integer, consumed_at integer);
    create table if not exists cli_installation (id text primary key, user_id text not null, label text not null, token_hash text not null unique, scopes_json text not null, created_at integer not null, last_used_at integer, expires_at integer not null, revoked_at integer);
    create table if not exists cli_turnstile_challenge (id text primary key, user_id text not null, installation_id text not null, status text not null default 'pending', requires_turnstile integer not null default 1, created_at integer not null, expires_at integer not null, verified_at integer, consumed_at integer);
    create index if not exists cli_turnstile_challenge_installation_status_idx on cli_turnstile_challenge (installation_id, status, expires_at);
    create index if not exists cli_turnstile_challenge_user_expiry_idx on cli_turnstile_challenge (user_id, expires_at);
    create table if not exists model_alias (id text primary key, tool text not null, raw_label text not null, normalized_label text not null, tracked_item_id text not null, created_at integer not null, updated_at integer not null, unique(tool, normalized_label));
    create table if not exists catalog_candidate (id text primary key, name text not null, normalized_key text not null unique, provider_name text not null, type text not null, source text not null, source_url text, raw_label text, version_label text, release_at integer, provenance_json text not null default '[]', status text not null default 'pending', first_seen_at integer not null, last_seen_at integer not null, seen_count integer not null default 1, created_at integer not null, updated_at integer not null);
    create index if not exists catalog_candidate_status_seen_idx on catalog_candidate (status, last_seen_at);
    create table if not exists feedback_context (id text primary key, user_id text not null, installation_id text not null, tracked_item_id text not null, session_hash text not null, tool text not null, raw_model_label text, attribution text not null, adapter_version text not null, session_duration_bucket text not null default 'unknown', created_at integer not null, unique(installation_id, session_hash));
    create table if not exists feedback_report (id text primary key, user_id text not null, tracked_item_id text not null, agent_item_id text, result_quality_rating integer not null, usage_efficiency_rating integer not null, tags_json text not null, short_comment text, effective_weight real not null, moderation_status text not null, fraud_risk_score real not null, included_in_scores integer not null, duplicate_cluster_adjustment real not null default 1, ip_hash text, device_hash text, idempotency_key text not null, source text not null default 'web', feedback_context_id text unique, client_event_id text unique, submitted_at integer not null, edited_at integer, created_at integer not null, updated_at integer not null, unique(user_id, idempotency_key));
    create table if not exists aggregate (id text primary key, tracked_item_id text not null, period text not null, period_start integer not null, period_end integer not null, report_count integer not null, weighted_report_count real not null, overall_score real not null, result_quality_score real not null, usage_efficiency_score real not null, confidence real not null, change real not null, state text not null, snapshot_day integer not null, calculated_at integer not null, unique(tracked_item_id, period, snapshot_day));
    create index if not exists aggregate_item_period_calculated_idx on aggregate (tracked_item_id, period, calculated_at);
    create index if not exists aggregate_item_period_end_idx on aggregate (tracked_item_id, period, period_end);
    create index if not exists aggregate_period_calculated_item_idx on aggregate (period, calculated_at, tracked_item_id);
    create table if not exists settings (key text primary key, value_json text not null, updated_at integer not null, updated_by text);
    create table if not exists audit_log (id text primary key, actor_user_id text, action text not null, entity_type text not null, entity_id text not null, before_json text, after_json text, created_at integer not null);
    create index if not exists audit_log_entity_idx on audit_log (entity_type, entity_id, created_at);
    create table if not exists aggregation_job_lock (key text primary key, locked_until integer not null, updated_at integer not null);
    create table if not exists risk_event (id text primary key, user_id text, kind text not null, score real not null, expires_at integer not null, created_at integer not null);
  `);
};

export const insertItem = async (env: Env, id: string, slug: string): Promise<void> => {
  const now = Date.now();
  await env.DB.prepare("insert or ignore into tracked_item (id, name, slug, provider_name, type, official_url, is_active, sort_order, created_at, updated_at) values (?, ?, ?, 'Test', 'model', 'https://example.com', 1, 0, ?, ?)")
    .bind(id, slug, slug, now, now).run();
};
