import type { Env } from "../env";
import { getProfile, type ProfileRecord } from "../db/repositories";
import { stableHash } from "../lib/crypto";
import { HttpError } from "../lib/http";
import type { CurrentIdentity } from "./auth";

const DEVICE_CODE_TTL_MS = 10 * 60_000;
const INSTALLATION_TTL_MS = 365 * 24 * 60 * 60_000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const randomHex = (bytes: number): string => {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const randomUserCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
};

export const normalizeUserCode = (value: string): string => value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface DeviceAuthorizationStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export const startDeviceAuthorization = async (
  env: Env,
  clientName: string,
  now = Date.now()
): Promise<DeviceAuthorizationStart> => {
  const deviceCode = randomHex(32);
  let userCode = randomUserCode();
  let inserted = false;
  for (let attempt = 0; attempt < 4 && !inserted; attempt += 1) {
    try {
      await env.DB.prepare(
        `insert into cli_device_authorization
          (id, device_code_hash, user_code, status, user_id, client_name, created_at, expires_at)
         values (?, ?, ?, 'pending', null, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(),
        await stableHash(env.BETTER_AUTH_SECRET, deviceCode),
        normalizeUserCode(userCode),
        clientName,
        now,
        now + DEVICE_CODE_TTL_MS
      ).run();
      inserted = true;
    } catch (error) {
      if (attempt === 3) throw error;
      userCode = randomUserCode();
    }
  }
  const verificationUri = `${env.BETTER_AUTH_URL}/cli/authorize`;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expiresIn: DEVICE_CODE_TTL_MS / 1000,
    interval: 3
  };
};

export const approveDeviceAuthorization = async (
  env: Env,
  identity: CurrentIdentity,
  userCode: string,
  now = Date.now()
): Promise<{ clientName: string }> => {
  const normalized = normalizeUserCode(userCode);
  const record = await env.DB.prepare(
    `select id, client_name, status, expires_at from cli_device_authorization where user_code = ? limit 1`
  ).bind(normalized).first<{ id: string; client_name: string; status: string; expires_at: number }>();
  if (!record) throw new HttpError(404, "device_code_not_found", "That device code is not valid.");
  if (record.expires_at <= now) {
    await env.DB.prepare("update cli_device_authorization set status = 'expired' where id = ?").bind(record.id).run();
    throw new HttpError(410, "device_code_expired", "That device code has expired. Start login again from the CLI.");
  }
  if (record.status !== "pending") throw new HttpError(409, "device_code_unavailable", "That device code has already been used.");
  const outcome = await env.DB.prepare(
    `update cli_device_authorization set status = 'approved', user_id = ?, approved_at = ?
     where id = ? and status = 'pending' and expires_at > ?`
  ).bind(identity.userId, now, record.id, now).run();
  if (!outcome.meta.changes) throw new HttpError(409, "device_code_unavailable", "That device code has already been used.");
  return { clientName: record.client_name };
};

export const exchangeDeviceAuthorization = async (
  env: Env,
  deviceCode: string,
  now = Date.now()
): Promise<{ accessToken: string; tokenType: "Bearer"; expiresIn: number }> => {
  const deviceCodeHash = await stableHash(env.BETTER_AUTH_SECRET, deviceCode);
  const record = await env.DB.prepare(
    `select id, user_id, client_name, status, expires_at from cli_device_authorization where device_code_hash = ? limit 1`
  ).bind(deviceCodeHash).first<{ id: string; user_id: string | null; client_name: string; status: string; expires_at: number }>();
  if (!record) throw new HttpError(400, "invalid_device_code", "The device code is invalid.");
  if (record.expires_at <= now || record.status === "expired") {
    await env.DB.prepare("update cli_device_authorization set status = 'expired' where id = ?").bind(record.id).run();
    throw new HttpError(410, "device_code_expired", "The device authorization expired.");
  }
  if (record.status === "pending") throw new HttpError(428, "authorization_pending", "Complete authorization in your browser.");
  if (!record.user_id || (record.status !== "approved" && record.status !== "consumed")) {
    throw new HttpError(409, "device_code_unavailable", "The device authorization cannot be completed.");
  }

  // The credential is deterministically derived from the one-time device code.
  // This makes a repeated poll idempotent without storing a plaintext credential.
  const accessToken = `iai_${await stableHash(env.BETTER_AUTH_SECRET, `cli-token:${deviceCode}`)}`;
  const tokenHash = await stableHash(env.BETTER_AUTH_SECRET, accessToken);
  const installationExpiresAt = now + INSTALLATION_TTL_MS;
  await env.DB.batch([
    env.DB.prepare(
      `insert into cli_installation
        (id, user_id, label, token_hash, scopes_json, created_at, last_used_at, expires_at, revoked_at)
       values (?, ?, ?, ?, '["allowance:read","feedback:write"]', ?, null, ?, null)
       on conflict(id) do nothing`
    ).bind(record.id, record.user_id, record.client_name, tokenHash, now, installationExpiresAt),
    env.DB.prepare(
      `update cli_device_authorization set status = 'consumed', consumed_at = coalesce(consumed_at, ?)
       where id = ? and status in ('approved', 'consumed')`
    ).bind(now, record.id)
  ]);
  const installation = await env.DB.prepare(
    "select expires_at from cli_installation where id = ? and token_hash = ? and revoked_at is null"
  ).bind(record.id, tokenHash).first<{ expires_at: number }>();
  if (!installation) throw new HttpError(409, "device_code_unavailable", "The device authorization cannot be completed.");
  return {
    accessToken,
    tokenType: "Bearer",
    expiresIn: Math.max(0, Math.floor((installation.expires_at - now) / 1000))
  };
};

export interface CliIdentity extends CurrentIdentity {
  installationId: string;
  scopes: string[];
}

const getBearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice(7).trim() || null;
};

export const requireCliIdentity = async (
  request: Request,
  env: Env,
  requiredScope?: "allowance:read" | "feedback:write"
): Promise<CliIdentity> => {
  const token = getBearerToken(request);
  if (!token) throw new HttpError(401, "cli_authentication_required", "Run `isaiokay login` to connect this CLI.");
  const tokenHash = await stableHash(env.BETTER_AUTH_SECRET, token);
  const now = Date.now();
  const installation = await env.DB.prepare(
    `select id, user_id, scopes_json from cli_installation
     where token_hash = ? and revoked_at is null and expires_at > ? limit 1`
  ).bind(tokenHash, now).first<{ id: string; user_id: string; scopes_json: string }>();
  if (!installation) throw new HttpError(401, "cli_credential_invalid", "This CLI credential is invalid, expired, or revoked.");
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(installation.scopes_json) as unknown;
    scopes = Array.isArray(parsed) ? parsed.filter((scope): scope is string => typeof scope === "string") : [];
  } catch {
    throw new HttpError(401, "cli_credential_invalid", "This CLI credential has invalid scopes.");
  }
  if (requiredScope && !scopes.includes(requiredScope)) throw new HttpError(403, "cli_scope_required", "The CLI credential does not have the required scope.");

  const user = await env.DB.prepare("select id, name, image from user where id = ? limit 1")
    .bind(installation.user_id).first<{ id: string; name: string; image: string | null }>();
  const profile: ProfileRecord | null = await getProfile(env, installation.user_id);
  if (!user || !profile || profile.status === "suspended" || profile.status === "deleted") {
    throw new HttpError(403, "account_unavailable", "This account cannot submit feedback.");
  }
  await env.DB.prepare("update cli_installation set last_used_at = ? where id = ?").bind(now, installation.id).run();
  return {
    userId: user.id,
    name: user.name,
    image: user.image,
    profile,
    isDevelopmentMock: false,
    installationId: installation.id,
    scopes
  };
};

export const revokeCliInstallation = async (env: Env, identity: CliIdentity, now = Date.now()): Promise<void> => {
  await env.DB.prepare("update cli_installation set revoked_at = ? where id = ? and user_id = ?")
    .bind(now, identity.installationId, identity.userId).run();
};
