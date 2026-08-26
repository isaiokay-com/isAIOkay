import type { Env, RateLimitBinding } from "../env";
import { HttpError } from "./http";

export type RateLimitName =
  | "AUTH_RATE_LIMIT"
  | "FEEDBACK_MODAL_RATE_LIMIT"
  | "FEEDBACK_RATE_LIMIT"
  | "TELEMETRY_RATE_LIMIT"
  | "ALLOWANCE_RATE_LIMIT"
  | "ADMIN_RATE_LIMIT";

export const enforceRateLimit = async (binding: RateLimitBinding | undefined, key: string): Promise<void> => {
  if (!binding) {
    throw new HttpError(503, "rate_limit_unconfigured", "This operation is temporarily unavailable.");
  }
  const outcome = await binding.limit({ key });
  if (!outcome.success) {
    throw new HttpError(429, "rate_limited", "Please slow down and try again shortly.");
  }
};

export const enforceNamedRateLimit = (env: Env, name: RateLimitName, key: string): Promise<void> =>
  enforceRateLimit(env[name], key);
