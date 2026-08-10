import type { ApiTrackedItem, CliCredential } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);

export const stripTerminalControls = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

export const normalizeSameOriginWebUrl = (value: unknown, serverUrl: string): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const server = new URL(serverUrl);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== server.origin || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return {};
  try {
    if (!response.body) return {};
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytesRead = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return {};
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

const request = async (
  fetcher: Fetch,
  url: string,
  init: RequestInit,
  token?: string
): Promise<Record<string, unknown>> => {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetcher(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = typeof body.error === "object" && body.error !== null ? body.error as Record<string, unknown> : {};
    throw new ApiError(
      response.status,
      typeof error.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : "request_failed",
      typeof error.message === "string" ? stripTerminalControls(error.message).slice(0, 500) : `Request failed (${response.status}).`,
      typeof error.details === "object" && error.details !== null ? error.details as Record<string, unknown> : undefined
    );
  }
  return body;
};

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export const startDeviceLogin = async (fetcher: Fetch, serverUrl: string): Promise<DeviceStart> => {
  const body = await request(fetcher, `${serverUrl}/api/cli/device/start`, {
    method: "POST",
    body: JSON.stringify({ clientName: "IsAIokay.com CLI" })
  });
  const verificationUriComplete = normalizeSameOriginWebUrl(body.verificationUriComplete, serverUrl);
  if (
    typeof body.deviceCode !== "string" || !/^[a-f0-9]{64}$/.test(body.deviceCode) ||
    typeof body.userCode !== "string" || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(body.userCode) ||
    verificationUriComplete === null ||
    typeof body.expiresIn !== "number" || !Number.isInteger(body.expiresIn) || body.expiresIn < 1 || body.expiresIn > 1800 ||
    typeof body.interval !== "number" || !Number.isInteger(body.interval) || body.interval < 1 || body.interval > 60
  ) throw new ApiError(502, "invalid_server_response", "The server returned an invalid device authorization response.");
  return {
    deviceCode: body.deviceCode,
    userCode: body.userCode,
    verificationUriComplete,
    expiresIn: body.expiresIn,
    interval: body.interval
  };
};

export const pollDeviceLogin = async (
  fetcher: Fetch,
  serverUrl: string,
  deviceCode: string
): Promise<{ accessToken: string; expiresIn: number }> => {
  const body = await request(fetcher, `${serverUrl}/api/cli/device/token`, {
    method: "POST",
    body: JSON.stringify({ deviceCode })
  });
  if (
    typeof body.accessToken !== "string" || !/^iai_[a-f0-9]{64}$/.test(body.accessToken) ||
    typeof body.expiresIn !== "number" || !Number.isInteger(body.expiresIn) || body.expiresIn < 1 || body.expiresIn > 366 * 24 * 60 * 60
  ) {
    throw new ApiError(502, "invalid_server_response", "The server returned an invalid CLI credential response.");
  }
  return { accessToken: body.accessToken, expiresIn: body.expiresIn };
};

export const approveDeviceLogin = async (
  fetcher: Fetch,
  credential: CliCredential,
  userCode: string
): Promise<{ clientName: string }> => {
  const body = await credentialRequest(fetcher, credential, "/api/cli/device/approve", {
    method: "POST",
    body: JSON.stringify({ userCode })
  });
  if (body.ok !== true || typeof body.clientName !== "string" || body.clientName.length > 100) {
    throw new ApiError(502, "invalid_server_response", "The server returned an invalid device approval response.");
  }
  return { clientName: stripTerminalControls(body.clientName) };
};

const credentialRequest = (
  fetcher: Fetch,
  credential: CliCredential,
  path: string,
  init: RequestInit
): Promise<Record<string, unknown>> => request(fetcher, `${credential.serverUrl}${path}`, init, credential.accessToken);

export const getAllowance = async (fetcher: Fetch, credential: CliCredential): Promise<Record<string, unknown>> =>
  credentialRequest(fetcher, credential, "/api/cli/allowance", { method: "GET" });

export const getTrackedItems = async (fetcher: Fetch, credential: CliCredential): Promise<ApiTrackedItem[]> => {
  const body = await credentialRequest(fetcher, credential, "/api/cli/items", { method: "GET" });
  if (!Array.isArray(body.items)) throw new ApiError(502, "invalid_server_response", "The server returned an invalid item catalog.");
  return body.items.flatMap((value): ApiTrackedItem[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (
      typeof item.id !== "string" || typeof item.slug !== "string" || typeof item.name !== "string" ||
      typeof item.providerName !== "string" || (item.type !== "model" && item.type !== "agent")
    ) return [];
    return [{
      id: item.id,
      slug: item.slug,
      name: stripTerminalControls(item.name),
      providerName: stripTerminalControls(item.providerName),
      type: item.type
    }];
  });
};

export const submitFeedback = async (
  fetcher: Fetch,
  credential: CliCredential,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> => credentialRequest(fetcher, credential, "/api/cli/feedback", {
  method: "POST",
  body: JSON.stringify(payload)
});

export interface CliTurnstileChallengeStatus {
  id: string;
  status: "pending" | "verified" | "consumed" | "expired";
  expiresAt: number;
  challengeProof: string | null;
}

/** Polls a challenge with the same scoped bearer credential that created it. */
export const getCliTurnstileChallenge = async (
  fetcher: Fetch,
  credential: CliCredential,
  challengeId: string
): Promise<CliTurnstileChallengeStatus> => {
  const body = await credentialRequest(fetcher, credential, `/api/cli/challenges/${encodeURIComponent(challengeId)}`, { method: "GET" });
  const status = body.status;
  if (
    !isUuid(body.id) || body.id !== challengeId ||
    (status !== "pending" && status !== "verified" && status !== "consumed" && status !== "expired") ||
    typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) ||
    (body.challengeProof !== null && (typeof body.challengeProof !== "string" || !/^[a-f0-9]{64}$/.test(body.challengeProof)))
  ) {
    throw new ApiError(502, "invalid_server_response", "The server returned an invalid browser verification status.");
  }
  return { id: body.id, status, expiresAt: body.expiresAt, challengeProof: body.challengeProof as string | null };
};

export const revokeCredential = async (fetcher: Fetch, credential: CliCredential): Promise<void> => {
  await credentialRequest(fetcher, credential, "/api/cli/revoke", { method: "POST", body: "{}" });
};
