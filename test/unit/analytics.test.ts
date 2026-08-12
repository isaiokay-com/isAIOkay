import { describe, expect, it } from "vitest";
import { isAnalyticsPath, postHogHost, postHogProjectKey, publicAnalyticsUrl } from "../../src/lib/analytics-policy";

describe("analytics privacy policy", () => {
  it("allows only the ranking and model page shapes", () => {
    expect(isAnalyticsPath("/")).toBe(true);
    expect(isAnalyticsPath("/openai/gpt-5")).toBe(true);
    expect(isAnalyticsPath("/openai/gpt-5.6-sol")).toBe(true);
    expect(isAnalyticsPath("/cli/authorize")).toBe(false);
    expect(isAnalyticsPath("/cli/verify/private-token")).toBe(false);
    expect(isAnalyticsPath("/u/developer")).toBe(false);
    expect(isAnalyticsPath("/admin")).toBe(false);
    expect(isAnalyticsPath("/admin/reports")).toBe(false);
    expect(isAnalyticsPath("/api/items")).toBe(false);
    expect(isAnalyticsPath("/ph/e")).toBe(false);
    expect(isAnalyticsPath("/privacy")).toBe(false);
  });

  it("accepts only supported PostHog Cloud ingestion hosts", () => {
    expect(postHogHost("https://us.i.posthog.com/")).toBe("https://us.i.posthog.com");
    expect(postHogHost("https://untrusted.example")).toBeNull();
    expect(postHogHost(undefined)).toBe("https://us.i.posthog.com");
  });

  it("allows only public project keys into rendered analytics configuration", () => {
    expect(postHogProjectKey(" phc_public_project_key ")).toBe("phc_public_project_key");
    expect(postHogProjectKey("phx_personal_api_key")).toBeNull();
    expect(postHogProjectKey(undefined)).toBeNull();
  });

  it("removes query strings and fragments from analytics URL properties", () => {
    expect(publicAnalyticsUrl("https://isaiokay.com/?feedback=model#feedback")).toBe("https://isaiokay.com/");
    expect(publicAnalyticsUrl("https://isaiokay.com/openai/gpt-5?token=private")).toBe("https://isaiokay.com/openai/gpt-5");
    expect(publicAnalyticsUrl("https://search.example/results?q=private#match")).toBe("https://search.example/results");
    expect(publicAnalyticsUrl("not a URL")).toBeNull();
  });
});
