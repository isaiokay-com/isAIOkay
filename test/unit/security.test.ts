import { describe, expect, it } from "vitest";
import { httpsUrlSchema, isSafeHttpsUrl, isXUsername, serializeJsonForHtml } from "../../src/lib/security";
import { parseAppSettings } from "../../src/lib/settings";

describe("security helpers", () => {
  it("prevents JSON-LD values from closing the inline script", () => {
    const serialized = serializeJsonForHtml({ name: "</script><script>alert(1)</script>\u2028" });
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain("\u2028");
    expect(JSON.parse(serialized)).toEqual({ name: "</script><script>alert(1)</script>\u2028" });
  });

  it("accepts only credential-free HTTPS URLs", () => {
    expect(isSafeHttpsUrl("https://provider.example/model")).toBe(true);
    expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("http://provider.example/model")).toBe(false);
    expect(isSafeHttpsUrl("https://user:password@provider.example/model")).toBe(false);
    expect(httpsUrlSchema.safeParse("https://provider.example/model").success).toBe(true);
  });

  it("accepts only valid X usernames", () => {
    expect(isXUsername("Exact_X_Handle")).toBe(true);
    expect(isXUsername("not-an-x-handle")).toBe(false);
    expect(isXUsername("way_too_long_for_an_x_username")).toBe(false);
  });

  it("rejects malformed persisted settings while accepting partial legacy rows", () => {
    expect(parseAppSettings({ riskRetentionDays: 30 }).riskRetentionDays).toBe(30);
    expect(() => parseAppSettings({ bayesianPriorWeight: 0 })).toThrow();
    expect(() => parseAppSettings({ catalogProviderFeeds: [{ provider: "Unsafe", url: "http://127.0.0.1/feed" }] })).toThrow();
  });
});
