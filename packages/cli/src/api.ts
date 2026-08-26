import type { ApiTrackedItem, CliCredential, LocalSubscription, StoredQuotaSnapshot, StoredUsageSlice } from "./types.js";

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
    const responseCode = error.code ?? body.code;
    const responseMessage = error.message ?? body.message;
    throw new ApiError(
      response.status,
      typeof responseCode === "string" && /^[a-z0-9_]{1,64}$/.test(responseCode) ? responseCode : "request_failed",
      typeof responseMessage === "string" ? stripTerminalControls(responseMessage).slice(0, 500) : `Request failed (${response.status}).`,
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

export interface ApiAllowance {
  remaining: number;
  nextAvailableAt: string | null;
  alreadyRatedItemIds: string[];
}

export const getAllowance = async (fetcher: Fetch, credential: CliCredential): Promise<ApiAllowance> => {
  const body = await credentialRequest(fetcher, credential, "/api/cli/allowance", { method: "GET" });
  if (
    !Number.isInteger(body.remaining) || (body.remaining as number) < 0 || (body.remaining as number) > 2 ||
    (body.nextAvailableAt !== null && typeof body.nextAvailableAt !== "string") ||
    !Array.isArray(body.alreadyRatedItemIds) || !body.alreadyRatedItemIds.every((id) => typeof id === "string")
  ) {
    throw new ApiError(502, "invalid_server_response", "The server returned an invalid rating allowance.");
  }
  return {
    remaining: body.remaining as number,
    nextAvailableAt: body.nextAvailableAt as string | null,
    alreadyRatedItemIds: body.alreadyRatedItemIds as string[]
  };
};

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

export const upsertSubscription = async (
  fetcher: Fetch,
  credential: CliCredential,
  subscription: LocalSubscription
): Promise<void> => {
  const body = await credentialRequest(fetcher, credential, "/api/cli/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      clientSubscriptionId: subscription.id,
      providerName: subscription.providerName,
      planLabel: subscription.planLabel,
      ...(subscription.planSlug ? { planSlug: subscription.planSlug } : {}),
      billingPeriod: subscription.billingPeriod,
      priceMicros: subscription.priceMicros,
      currency: subscription.currency,
      startedAt: subscription.startedAt,
      endedAt: subscription.endedAt,
      aggregateConsent: subscription.aggregateConsent
    })
  });
  if (typeof body.subscription !== "object" || body.subscription === null) {
    throw new ApiError(502, "invalid_server_response", "The server returned an invalid subscription response.");
  }
};

export interface ApiSubscriptionPlan {
  slug: string;
  providerName: string;
  name: string;
  billingPeriod: "monthly" | "annual" | "weekly" | "other";
  priceMicros: number | null;
  currency: string;
}

export const getSubscriptionPlans = async (fetcher: Fetch, credential: CliCredential): Promise<ApiSubscriptionPlan[]> => {
  const body = await credentialRequest(fetcher, credential, "/api/cli/subscriptions", { method: "GET" });
  if (!Array.isArray(body.plans)) throw new ApiError(502, "invalid_server_response", "The server returned an invalid subscription catalog.");
  return body.plans.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const plan = value as Record<string, unknown>;
    if (
      typeof plan.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plan.slug) ||
      typeof plan.providerName !== "string" || plan.providerName.length < 1 || plan.providerName.length > 80 ||
      typeof plan.name !== "string" || plan.name.length < 1 || plan.name.length > 100 ||
      (plan.billingPeriod !== "monthly" && plan.billingPeriod !== "annual" && plan.billingPeriod !== "weekly" && plan.billingPeriod !== "other") ||
      (plan.priceMicros !== null && (!Number.isSafeInteger(plan.priceMicros) || (plan.priceMicros as number) < 0 || (plan.priceMicros as number) > 1_000_000_000_000)) ||
      typeof plan.currency !== "string" || !/^[A-Z]{3}$/.test(plan.currency)
    ) return [];
    return [{
      slug: plan.slug,
      providerName: stripTerminalControls(plan.providerName),
      name: stripTerminalControls(plan.name),
      billingPeriod: plan.billingPeriod,
      priceMicros: plan.priceMicros as number | null,
      currency: plan.currency
    }];
  });
};

const usagePayload = (entry: StoredUsageSlice): Record<string, unknown> => ({
  clientEventId: entry.id,
  clientSubscriptionId: entry.subscriptionId,
  tool: entry.tool,
  sessionHash: entry.sessionHash,
  requestHash: entry.requestHash,
  requestedModel: entry.requestedModel,
  reportedModel: entry.reportedModel,
  modelFamily: entry.modelFamily,
  modelVersion: entry.modelVersion,
  reasoningEffort: entry.reasoningEffort,
  modelVariant: entry.modelVariant,
  serviceTier: entry.serviceTier,
  querySource: entry.querySource,
  granularity: entry.granularity,
  attributionQuality: entry.attributionQuality,
  tokenAttributionQuality: entry.tokenAttributionQuality,
  modelAttributionQuality: entry.modelAttributionQuality,
  effortAttributionQuality: entry.effortAttributionQuality,
  inputTokens: entry.inputTokens,
  cacheReadTokens: entry.cacheReadTokens,
  cacheWriteTokens: entry.cacheWriteTokens,
  outputTokens: entry.outputTokens,
  reasoningTokens: entry.reasoningTokens,
  reportedTotalTokens: entry.reportedTotalTokens,
  observedAt: entry.observedAt,
  collectorVersion: "0.3.0"
});

const quotaPayload = (entry: StoredQuotaSnapshot): Record<string, unknown> => ({
  clientEventId: entry.id,
  clientSubscriptionId: entry.subscriptionId,
  quotaScope: entry.quotaScope,
  windowKind: entry.windowKind,
  usedPercent: entry.usedPercent,
  remainingPercent: entry.remainingPercent,
  resetAt: entry.resetAt,
  attributionQuality: entry.attributionQuality,
  observedAt: entry.observedAt,
  collectorVersion: "0.3.0"
});

export const uploadTelemetry = async (
  fetcher: Fetch,
  credential: CliCredential,
  usage: StoredUsageSlice[],
  quota: StoredQuotaSnapshot[]
): Promise<{ accepted: number; duplicates: number }> => {
  const body = await credentialRequest(fetcher, credential, "/api/cli/telemetry", {
    method: "POST",
    body: JSON.stringify({ usage: usage.map(usagePayload), quota: quota.map(quotaPayload) })
  });
  if (!Number.isInteger(body.accepted) || (body.accepted as number) < 0 || (body.accepted as number) > 100 ||
    !Number.isInteger(body.duplicates) || (body.duplicates as number) < 0 || (body.duplicates as number) > 100 ||
    (body.accepted as number) + (body.duplicates as number) !== usage.length + quota.length
  ) {
    throw new ApiError(502, "invalid_server_response", "The server returned an invalid telemetry response.");
  }
  return { accepted: body.accepted as number, duplicates: body.duplicates as number };
};

export interface CloudUsageRow {
  clientSubscriptionId: string;
  planLabel: string;
  providerName: string;
  reportedModel: string;
  reasoningEffort: string;
  querySource: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  observedTokens: number;
  usageSliceCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
}

export const getCloudUsage = async (
  fetcher: Fetch,
  credential: CliCredential,
  period: "7d" | "30d" | "90d" | "all"
): Promise<CloudUsageRow[]> => {
  const body = await credentialRequest(fetcher, credential, `/api/cli/usage?period=${period}`, { method: "GET" });
  if (!Array.isArray(body.rows)) throw new ApiError(502, "invalid_server_response", "The server returned an invalid usage summary.");
  return body.rows.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const texts = ["clientSubscriptionId", "planLabel", "providerName", "reportedModel", "reasoningEffort", "querySource"] as const;
    const numbers = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "observedTokens", "usageSliceCount", "firstObservedAt", "lastObservedAt"] as const;
    if (!texts.every((key) => typeof row[key] === "string") ||
      !isUuid(row.clientSubscriptionId) ||
      !["main", "subagent", "auxiliary", "background", "unknown"].includes(row.querySource as string) ||
      !numbers.every((key) => Number.isSafeInteger(row[key]) && (row[key] as number) >= 0)
    ) return [];
    return [{
      clientSubscriptionId: row.clientSubscriptionId as string,
      planLabel: stripTerminalControls(row.planLabel as string),
      providerName: stripTerminalControls(row.providerName as string),
      reportedModel: stripTerminalControls(row.reportedModel as string),
      reasoningEffort: stripTerminalControls(row.reasoningEffort as string),
      querySource: row.querySource as string,
      inputTokens: row.inputTokens as number,
      cacheReadTokens: row.cacheReadTokens as number,
      cacheWriteTokens: row.cacheWriteTokens as number,
      outputTokens: row.outputTokens as number,
      reasoningTokens: row.reasoningTokens as number,
      observedTokens: row.observedTokens as number,
      usageSliceCount: row.usageSliceCount as number,
      firstObservedAt: row.firstObservedAt as number,
      lastObservedAt: row.lastObservedAt as number
    }];
  });
};

export const deleteRemoteTelemetry = async (
  fetcher: Fetch,
  credential: CliCredential,
  includeSubscriptions: boolean
): Promise<{ usageDeleted: number; quotaDeleted: number; subscriptionsDeleted: number }> => {
  const body = await credentialRequest(fetcher, credential, "/api/cli/telemetry", {
    method: "DELETE",
    body: JSON.stringify({ includeSubscriptions })
  });
  if (body.deleted !== true ||
    !Number.isInteger(body.usageDeleted) || (body.usageDeleted as number) < 0 ||
    !Number.isInteger(body.quotaDeleted) || (body.quotaDeleted as number) < 0 ||
    !Number.isInteger(body.subscriptionsDeleted) || (body.subscriptionsDeleted as number) < 0
  ) {
    throw new ApiError(502, "invalid_server_response", "The server returned an invalid telemetry deletion response.");
  }
  return {
    usageDeleted: body.usageDeleted as number,
    quotaDeleted: body.quotaDeleted as number,
    subscriptionsDeleted: body.subscriptionsDeleted as number
  };
};

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
