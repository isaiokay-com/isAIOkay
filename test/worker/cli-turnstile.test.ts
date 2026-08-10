import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";
import {
  cleanupCliTurnstileChallenges,
  completeCliTurnstileChallenge,
  consumeCliTurnstileChallenge,
  getCliTurnstileChallengeForBrowser,
  getCliTurnstileChallengeForCli,
  issueCliTurnstileChallenge
} from "../../src/services/cli-turnstile";
import { prepareTestDatabase } from "./setup";

const runtime = env as unknown as Env;
const now = 1_800_000_000_000;

const createCliIdentity = async () => {
  const userId = crypto.randomUUID();
  const installationId = crypto.randomUUID();
  await runtime.DB.batch([
    runtime.DB.prepare(
      "insert into user (id, name, email, emailVerified, createdAt, updatedAt) values (?, 'Challenge user', ?, 1, ?, ?)"
    ).bind(userId, `${userId}@test.local`, now, now),
    runtime.DB.prepare(
      `insert into user_profile
       (user_id, github_user_id, github_username, github_account_created_at, trust_category, trust_weight, status, first_login_at, last_login_at)
       values (?, ?, ?, ?, 'normal', 0.8, 'active', ?, ?)`
    ).bind(userId, `gh-${userId}`, `user-${userId.slice(0, 8)}`, now - 365 * 86_400_000, now - 86_400_000, now),
    runtime.DB.prepare(
      `insert into cli_installation
       (id, user_id, label, token_hash, scopes_json, created_at, expires_at)
       values (?, ?, 'test-cli', ?, '["allowance:read","feedback:write"]', ?, ?)`
    ).bind(installationId, userId, crypto.randomUUID(), now, now + 86_400_000)
  ]);
  return { userId, installationId };
};

beforeAll(async () => {
  await prepareTestDatabase(runtime);
});

describe("CLI browser Turnstile handoff", () => {
  it("issues a payload-free pending challenge when browser verification is required", async () => {
    const identity = await createCliIdentity();
    const challenge = await issueCliTurnstileChallenge(runtime, identity, now);
    const status = await getCliTurnstileChallengeForCli(runtime, challenge.id, identity, now);
    const row = await runtime.DB.prepare("select * from cli_turnstile_challenge where id = ?").bind(challenge.id).first<Record<string, unknown>>();

    expect(status).toMatchObject({ id: challenge.id, status: "pending", challengeProof: null });
    expect(row).toMatchObject({ user_id: identity.userId, installation_id: identity.installationId, status: "pending" });
    expect(row).not.toHaveProperty("feedback_json");
    expect(row).not.toHaveProperty("payload");
  });

  it("returns a proof to the same CLI after browser verification and consumes it once", async () => {
    const identity = await createCliIdentity();
    const challenge = await issueCliTurnstileChallenge(runtime, identity, now);
    await completeCliTurnstileChallenge(runtime, challenge.id, identity.userId, now + 1);
    const verified = await getCliTurnstileChallengeForCli(runtime, challenge.id, identity, now + 2);

    expect(verified.status).toBe("verified");
    expect(verified.challengeProof).toMatch(/^[a-f0-9]{64}$/);
    await consumeCliTurnstileChallenge(runtime, identity, challenge.id, verified.challengeProof!, now + 3);
    await expect(consumeCliTurnstileChallenge(runtime, identity, challenge.id, verified.challengeProof!, now + 4))
      .rejects.toMatchObject({ status: 409, code: "cli_verification_replayed" });
  });

  it("rejects a browser session for a different user", async () => {
    const owner = await createCliIdentity();
    const other = await createCliIdentity();
    const challenge = await issueCliTurnstileChallenge(runtime, owner, now);

    await expect(getCliTurnstileChallengeForBrowser(runtime, challenge.id, other.userId, now))
      .rejects.toMatchObject({ status: 403, code: "cli_verification_wrong_user" });
  });

  it("expires pending and verified challenges before they can be used", async () => {
    const identity = await createCliIdentity();
    const challenge = await issueCliTurnstileChallenge(runtime, identity, now);
    const expired = await getCliTurnstileChallengeForCli(runtime, challenge.id, identity, challenge.expiresAt);

    expect(expired).toMatchObject({ status: "expired", challengeProof: null });
    await expect(completeCliTurnstileChallenge(runtime, challenge.id, identity.userId, challenge.expiresAt + 1))
      .rejects.toMatchObject({ status: 410, code: "cli_verification_expired" });
  });

  it("cleans up expired challenge state after its short retention window", async () => {
    const identity = await createCliIdentity();
    const challenge = await issueCliTurnstileChallenge(runtime, identity, now);
    await cleanupCliTurnstileChallenges(runtime, challenge.expiresAt + 24 * 60 * 60_000 + 1);

    await expect(getCliTurnstileChallengeForCli(runtime, challenge.id, identity, challenge.expiresAt + 24 * 60 * 60_000 + 1))
      .rejects.toMatchObject({ status: 404, code: "cli_verification_not_found" });
  });
});
