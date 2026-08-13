import type { APIRoute } from "astro";
import { hasDeletedGitHubIdentity } from "../../../db/repositories";
import { appendSetCookie, json, toErrorResponse } from "../../../lib/http";
import { getRuntimeEnv } from "../../../lib/runtime";
import { DEVELOPMENT_USER_COOKIE, isDevelopmentMockEnabled } from "../../../services/auth";

export const prerender = false;

const identities = {
  trusted: {
    userId: "11111111-1111-4111-8111-111111111111",
    githubUserId: "101001",
    username: "edge-builder",
    name: "Edge Builder",
    ageDays: 365,
    trustCategory: "normal" as const,
    trustWeight: 0.8
  },
  suspicious: {
    userId: "22222222-2222-4222-8222-222222222222",
    githubUserId: "101002",
    username: "new-developer",
    name: "New Developer",
    ageDays: 14,
    trustCategory: "probation" as const,
    trustWeight: 0.55
  },
  blocked: {
    userId: "33333333-3333-4333-8333-333333333333",
    githubUserId: "101003",
    username: "very-new-dev",
    name: "Very New Developer",
    ageDays: 2,
    trustCategory: "blocked" as const,
    trustWeight: 0
  },
  admin: {
    userId: "44444444-4444-4444-8444-444444444444",
    githubUserId: "101004",
    username: "moderator",
    name: "Moderator",
    ageDays: 365,
    trustCategory: "normal" as const,
    trustWeight: 0.8
  }
};

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    if (!isDevelopmentMockEnabled(context.request, env)) return new Response("Not found", { status: 404 });
    const body = await context.request.json().catch(() => ({})) as { identity?: keyof typeof identities };
    const identity = identities[body.identity ?? "trusted"];
    if (await hasDeletedGitHubIdentity(env, identity.githubUserId)) {
      return json({ error: { code: "account_deleted", message: "This GitHub account was previously deleted and cannot be registered again." } }, { status: 403 });
    }
    const now = Date.now();
    const accountCreatedAt = now - identity.ageDays * 86_400_000;
    await env.DB.batch([
      env.DB.prepare("insert into user (id, name, email, emailVerified, image, githubUsername, githubAccountCreatedAt, createdAt, updatedAt) values (?, ?, ?, 0, null, ?, ?, ?, ?) on conflict(id) do update set name = excluded.name, githubUsername = excluded.githubUsername, githubAccountCreatedAt = excluded.githubAccountCreatedAt, updatedAt = excluded.updatedAt")
        .bind(identity.userId, identity.name, `github-${identity.githubUserId}@mock.local`, identity.username, accountCreatedAt, now, now),
      env.DB.prepare("insert into account (id, userId, accountId, providerId, createdAt, updatedAt) values (?, ?, ?, 'github', ?, ?) on conflict(providerId, accountId) do nothing")
        .bind(crypto.randomUUID(), identity.userId, identity.githubUserId, now, now),
      env.DB.prepare(
        `insert into user_profile (user_id, github_user_id, github_username, github_display_name, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(user_id) do update set github_user_id = excluded.github_user_id, github_username = excluded.github_username,
        github_display_name = excluded.github_display_name, github_account_created_at = excluded.github_account_created_at,
        trust_category = excluded.trust_category, trust_weight = excluded.trust_weight, status = excluded.status,
        last_login_at = excluded.last_login_at`
      ).bind(identity.userId, identity.githubUserId, identity.username, identity.name, accountCreatedAt, identity.trustCategory, identity.trustWeight, body.identity === "admin" ? "admin" : "active", now, now)
    ]);
    return appendSetCookie(json({ ok: true, userId: identity.userId }), `${DEVELOPMENT_USER_COOKIE}=${identity.userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`);
  } catch (error) {
    return toErrorResponse(error);
  }
};
