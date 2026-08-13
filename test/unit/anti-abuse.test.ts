import { describe, expect, it, vi } from "vitest";
import { enforceRateLimit } from "../../src/lib/rate-limit";
import { needsTurnstile, verifyTurnstile } from "../../src/lib/turnstile";
import { trustForAccountAge } from "../../src/lib/trust";
import { DEFAULT_SETTINGS } from "../../src/types";
import { getMinimalGitHubUserInfo } from "../../src/services/auth";
import { getDeletedGitHubIdentityHash } from "../../src/lib/deleted-identity";

describe("anti-abuse adapters", () => {
  it("derives stable deleted-identity markers with a dedicated HMAC secret", async () => {
    const secret = "dedicated-deletion-secret-with-at-least-thirty-two-characters";
    const first = await getDeletedGitHubIdentityHash(secret, "123456");
    await expect(getDeletedGitHubIdentityHash(secret, "123456")).resolves.toBe(first);
    await expect(getDeletedGitHubIdentityHash(secret, "654321")).resolves.not.toBe(first);
    await expect(getDeletedGitHubIdentityHash("too-short", "123456")).rejects.toThrow("DELETED_IDENTITY_SECRET");
  });

  it("handles rate-limit failures", async () => {
    await expect(enforceRateLimit(undefined, "key")).rejects.toMatchObject({ status: 503, code: "rate_limit_unconfigured" });
    await expect(enforceRateLimit({ limit: vi.fn().mockResolvedValue({ success: false }) }, "key")).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("requires Turnstile for unknown and probationary GitHub account age", () => {
    const now = Date.now();
    expect(needsTurnstile({ accountCreatedAt: null, suspicious: false, abnormalVelocity: false, now, settings: DEFAULT_SETTINGS })).toBe(true);
    expect(needsTurnstile({ accountCreatedAt: now - 14 * 86_400_000, suspicious: false, abnormalVelocity: false, now, settings: DEFAULT_SETTINGS })).toBe(true);
    expect(needsTurnstile({ accountCreatedAt: now - 365 * 86_400_000, suspicious: false, abnormalVelocity: false, now, settings: DEFAULT_SETTINGS })).toBe(false);
  });

  it("uses the local Turnstile mock only with explicit development mode", async () => {
    await expect(verifyTurnstile({ request: new Request("http://localhost/api/feedback"), env: { MOCK_GITHUB_AUTH: "true", BETTER_AUTH_URL: "http://localhost" } as never, token: "mock-turnstile-pass" })).resolves.toBeUndefined();
    await expect(verifyTurnstile({ request: new Request("http://localhost/api/feedback"), env: { MOCK_GITHUB_AUTH: "true", BETTER_AUTH_URL: "https://example.com" } as never, token: "mock-turnstile-pass" })).rejects.toMatchObject({ status: 503 });
    await expect(verifyTurnstile({ request: new Request("https://example.com/api/feedback"), env: { MOCK_GITHUB_AUTH: "true", BETTER_AUTH_URL: "http://localhost" } as never, token: "mock-turnstile-pass" })).rejects.toMatchObject({ status: 503 });
  });

  it("requires Turnstile to attest the expected hostname", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true }));
    await expect(verifyTurnstile({
      request: new Request("https://isaiokay.com/api/feedback"),
      env: { BETTER_AUTH_URL: "https://isaiokay.com", TURNSTILE_SECRET_KEY: "test-secret" } as never,
      token: "test-token",
      expectedHostname: "isaiokay.com"
    })).rejects.toMatchObject({ status: 400, code: "turnstile_failed" });
    fetchMock.mockRestore();
  });

  it("derives trust from GitHub account age only", () => {
    const now = Date.now();
    expect(trustForAccountAge(now - 2 * 86_400_000, DEFAULT_SETTINGS, now)).toMatchObject({ trustCategory: "blocked", blocked: true });
    expect(trustForAccountAge(now - 14 * 86_400_000, DEFAULT_SETTINGS, now)).toMatchObject({ trustCategory: "probation", blocked: false });
    expect(trustForAccountAge(now - 365 * 86_400_000, DEFAULT_SETTINGS, now)).toMatchObject({ trustCategory: "normal", trustWeight: 0.8 });
  });

  it("maps GitHub identity with one public-profile request and no email request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      id: 123456,
      login: "exact-handle",
      name: "Different Display Name",
      avatar_url: "https://avatars.githubusercontent.com/u/123456?v=4",
      created_at: "2012-01-02T03:04:05Z"
    }));
    const info = await getMinimalGitHubUserInfo("test-token");
    expect(info?.user).toMatchObject({
      id: "123456",
      email: "github-123456@isaiokay.invalid",
      githubUsername: "exact-handle",
      githubAccountCreatedAt: Date.parse("2012-01-02T03:04:05Z")
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/user");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
    fetchMock.mockRestore();
  });
});
