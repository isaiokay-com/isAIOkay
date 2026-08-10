import type { AppSettings, TrustCategory } from "../types";

export interface TrustDecision {
  trustCategory: TrustCategory;
  trustWeight: number;
  blocked: boolean;
}

export const trustForAccountAge = (
  accountCreatedAt: number | null,
  settings: AppSettings,
  now = Date.now()
): TrustDecision => {
  if (accountCreatedAt === null || !Number.isFinite(accountCreatedAt)) {
    return { trustCategory: "probation", trustWeight: 0.45, blocked: false };
  }
  const ageDays = (now - accountCreatedAt) / 86_400_000;
  if (ageDays < settings.minAccountAgeDays) return { trustCategory: "blocked", trustWeight: 0, blocked: true };
  if (ageDays < settings.probationAccountAgeDays) return { trustCategory: "probation", trustWeight: 0.55, blocked: false };
  return { trustCategory: "normal", trustWeight: 0.8, blocked: false };
};
