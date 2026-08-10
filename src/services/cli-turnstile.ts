import type { Env } from "../env";
import { stableHash } from "../lib/crypto";
import { HttpError } from "../lib/http";

const CHALLENGE_TTL_MS = 10 * 60_000;
const CLEANUP_RETENTION_MS = 24 * 60 * 60_000;

type ChallengeStatus = "pending" | "verified" | "consumed" | "expired";

interface ChallengeRecord {
  id: string;
  user_id: string;
  installation_id: string;
  status: ChallengeStatus;
  requires_turnstile: number;
  created_at: number;
  expires_at: number;
  verified_at: number | null;
  consumed_at: number | null;
}

export interface CliTurnstileChallengeIdentity {
  userId: string;
  installationId: string;
}

export interface BrowserCliTurnstileChallenge {
  id: string;
  status: ChallengeStatus;
  requiresTurnstile: boolean;
  createdAt: number;
  expiresAt: number;
  verifiedAt: number | null;
}

export interface CliTurnstileChallengeStatus extends BrowserCliTurnstileChallenge {
  challengeProof: string | null;
}

const toBrowserChallenge = (record: ChallengeRecord): BrowserCliTurnstileChallenge => ({
  id: record.id,
  status: record.status,
  requiresTurnstile: Boolean(record.requires_turnstile),
  createdAt: record.created_at,
  expiresAt: record.expires_at,
  verifiedAt: record.verified_at
});

const proofFor = (env: Env, challengeId: string): Promise<string> =>
  stableHash(env.BETTER_AUTH_SECRET, `cli-turnstile-proof:${challengeId}`);

const fixedTimeEquals = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

const expireChallenges = async (env: Env, now: number): Promise<void> => {
  await env.DB.prepare(
    `update cli_turnstile_challenge
     set status = 'expired'
     where status in ('pending', 'verified') and expires_at <= ?`
  ).bind(now).run();
};

const loadChallenge = async (env: Env, challengeId: string): Promise<ChallengeRecord> => {
  const record = await env.DB.prepare(
    `select id, user_id, installation_id, status, requires_turnstile, created_at, expires_at, verified_at, consumed_at
     from cli_turnstile_challenge where id = ? limit 1`
  ).bind(challengeId).first<ChallengeRecord>();
  if (!record) throw new HttpError(404, "cli_verification_not_found", "This CLI verification link is not valid.");
  return record;
};

const requireCliChallengeOwner = (record: ChallengeRecord, identity: CliTurnstileChallengeIdentity): void => {
  // Do not reveal a challenge that belongs to another user or installation to a
  // bearer credential. A challenge proof is useful only to its original CLI.
  if (record.user_id !== identity.userId || record.installation_id !== identity.installationId) {
    throw new HttpError(404, "cli_verification_not_found", "This CLI verification link is not valid.");
  }
};

const requireBrowserChallengeOwner = (record: ChallengeRecord, userId: string): void => {
  if (record.user_id !== userId) {
    throw new HttpError(403, "cli_verification_wrong_user", "Sign in with the account that started this CLI verification.");
  }
};

/**
 * Issues a payload-free challenge and invalidates any older unconsumed proof
 * for the same installation. The feedback body stays only in the CLI process.
 */
export const issueCliTurnstileChallenge = async (
  env: Env,
  identity: CliTurnstileChallengeIdentity,
  now = Date.now()
): Promise<BrowserCliTurnstileChallenge> => {
  await expireChallenges(env, now);
  const id = crypto.randomUUID();
  const expiresAt = now + CHALLENGE_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(
      `update cli_turnstile_challenge
       set status = 'expired'
       where user_id = ? and installation_id = ? and status in ('pending', 'verified') and expires_at > ?`
    ).bind(identity.userId, identity.installationId, now),
    env.DB.prepare(
      `insert into cli_turnstile_challenge
       (id, user_id, installation_id, status, requires_turnstile, created_at, expires_at, verified_at, consumed_at)
       values (?, ?, ?, 'pending', 1, ?, ?, null, null)`
    ).bind(id, identity.userId, identity.installationId, now, expiresAt)
  ]);
  return {
    id,
    status: "pending",
    requiresTurnstile: true,
    createdAt: now,
    expiresAt,
    verifiedAt: null
  };
};

/** Browser-facing state. It intentionally never exposes the CLI proof. */
export const getCliTurnstileChallengeForBrowser = async (
  env: Env,
  challengeId: string,
  userId: string,
  now = Date.now()
): Promise<BrowserCliTurnstileChallenge> => {
  await expireChallenges(env, now);
  const record = await loadChallenge(env, challengeId);
  requireBrowserChallengeOwner(record, userId);
  return toBrowserChallenge(record);
};

/** CLI polling state. A proof is returned only to the original bearer installation. */
export const getCliTurnstileChallengeForCli = async (
  env: Env,
  challengeId: string,
  identity: CliTurnstileChallengeIdentity,
  now = Date.now()
): Promise<CliTurnstileChallengeStatus> => {
  await expireChallenges(env, now);
  const record = await loadChallenge(env, challengeId);
  requireCliChallengeOwner(record, identity);
  return {
    ...toBrowserChallenge(record),
    challengeProof: record.status === "verified" ? await proofFor(env, record.id) : null
  };
};

/**
 * Marks a challenge verified after the browser endpoint has completed
 * server-side Turnstile verification. This does not store a Turnstile token or
 * feedback payload in D1.
 */
export const completeCliTurnstileChallenge = async (
  env: Env,
  challengeId: string,
  userId: string,
  now = Date.now()
): Promise<BrowserCliTurnstileChallenge> => {
  await expireChallenges(env, now);
  const record = await loadChallenge(env, challengeId);
  requireBrowserChallengeOwner(record, userId);
  if (record.status === "verified") return toBrowserChallenge(record);
  if (record.status === "expired") {
    throw new HttpError(410, "cli_verification_expired", "This browser verification link has expired. Return to the CLI for a fresh link.");
  }
  if (record.status !== "pending") {
    throw new HttpError(409, "cli_verification_unavailable", "This browser verification has already been used.");
  }
  const result = await env.DB.prepare(
    `update cli_turnstile_challenge
     set status = 'verified', verified_at = ?
     where id = ? and user_id = ? and status = 'pending' and expires_at > ?`
  ).bind(now, record.id, userId, now).run();
  if (result.meta.changes) {
    return { ...toBrowserChallenge(record), status: "verified", verifiedAt: now };
  }

  // A duplicate click can race its first request. Treat the completed browser
  // proof as idempotent, but never resurrect a consumed or expired challenge.
  const refreshed = await getCliTurnstileChallengeForBrowser(env, challengeId, userId, now);
  if (refreshed.status === "verified") return refreshed;
  if (refreshed.status === "expired") {
    throw new HttpError(410, "cli_verification_expired", "This browser verification link has expired. Return to the CLI for a fresh link.");
  }
  throw new HttpError(409, "cli_verification_unavailable", "This browser verification is no longer available.");
};

/**
 * Consumes the browser proof before the feedback Durable Object runs. A
 * conditional D1 update makes the proof single-use even if terminals retry in
 * parallel. The proof is deterministic from the server secret and challenge
 * id, so it never needs to be persisted in plaintext.
 */
export const consumeCliTurnstileChallenge = async (
  env: Env,
  identity: CliTurnstileChallengeIdentity,
  challengeId: string,
  proof: string,
  now = Date.now()
): Promise<void> => {
  await expireChallenges(env, now);
  const record = await loadChallenge(env, challengeId);
  requireCliChallengeOwner(record, identity);
  if (record.status === "expired") {
    throw new HttpError(410, "cli_verification_expired", "The browser verification expired. Start the report again for a fresh link.");
  }
  if (record.status === "pending") {
    throw new HttpError(428, "cli_verification_pending", "Complete browser verification before retrying this report.");
  }
  if (record.status === "consumed") {
    throw new HttpError(409, "cli_verification_replayed", "That browser verification proof has already been used.");
  }
  const expectedProof = await proofFor(env, record.id);
  if (!fixedTimeEquals(expectedProof, proof)) {
    throw new HttpError(403, "cli_verification_proof_invalid", "The browser verification proof is invalid.");
  }
  const result = await env.DB.prepare(
    `update cli_turnstile_challenge
     set status = 'consumed', consumed_at = ?
     where id = ? and user_id = ? and installation_id = ? and status = 'verified' and expires_at > ?`
  ).bind(now, record.id, identity.userId, identity.installationId, now).run();
  if (!result.meta.changes) {
    throw new HttpError(409, "cli_verification_replayed", "That browser verification proof has already been used.");
  }
};

/** Called from the cron path; expired links remain visible briefly for useful UX. */
export const cleanupCliTurnstileChallenges = async (env: Env, now = Date.now()): Promise<void> => {
  await expireChallenges(env, now);
  await env.DB.prepare(
    `delete from cli_turnstile_challenge
     where status in ('expired', 'consumed') and expires_at <= ?`
  ).bind(now - CLEANUP_RETENTION_MS).run();
};

export const cliTurnstileChallengeTtlMs = (): number => CHALLENGE_TTL_MS;
