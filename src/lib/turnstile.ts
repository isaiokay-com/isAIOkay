import type { Env } from "../env";
import type { AppSettings } from "../types";
import { HttpError, isLocalDevelopmentRequest } from "./http";

export interface TurnstileDecisionInput {
  accountCreatedAt: number | null;
  suspicious: boolean;
  abnormalVelocity: boolean;
  now: number;
  settings: AppSettings;
}

export const needsTurnstile = (input: TurnstileDecisionInput): boolean => {
  const accountAgeDays = input.accountCreatedAt === null ? null : (input.now - input.accountCreatedAt) / 86_400_000;
  if (accountAgeDays === null) return true;
  if (accountAgeDays >= input.settings.minAccountAgeDays && accountAgeDays < input.settings.probationAccountAgeDays) return input.settings.requireTurnstileForProbation;
  return (input.suspicious || input.abnormalVelocity) && input.settings.requireTurnstileForSuspicious;
};

interface TurnstileSiteverifyResponse {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
}

export const verifyTurnstile = async (args: {
  request: Request;
  env: Env;
  token: string | undefined;
  expectedHostname?: string;
}): Promise<void> => {
  const { request, env, token, expectedHostname } = args;
  if (!token) throw new HttpError(400, "turnstile_required", "Please complete the verification check.");

  // This is deliberately unavailable outside an explicit local development mock.
  if (String(env.MOCK_GITHUB_AUTH) === "true" && isLocalDevelopmentRequest(request, env.BETTER_AUTH_URL) && token === "mock-turnstile-pass") return;
  if (!env.TURNSTILE_SECRET_KEY) {
    throw new HttpError(503, "turnstile_unconfigured", "Verification is temporarily unavailable.");
  }

  const body = new FormData();
  body.set("secret", env.TURNSTILE_SECRET_KEY);
  body.set("response", token);
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp) body.set("remoteip", remoteIp);

  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new HttpError(503, "turnstile_unavailable", "Verification is temporarily unavailable.");
  }
  if (!response.ok) throw new HttpError(503, "turnstile_unavailable", "Verification is temporarily unavailable.");
  const result = await response.json() as TurnstileSiteverifyResponse;
  if (!result.success || (expectedHostname && result.hostname !== expectedHostname)) {
    throw new HttpError(400, "turnstile_failed", "Verification could not be confirmed.");
  }
};
