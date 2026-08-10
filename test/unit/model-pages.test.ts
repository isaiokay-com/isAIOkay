import { describe, expect, it } from "vitest";
import { matchesModelPageRoute, modelPagePath, modelPageSlug, providerPageSlug } from "../../src/lib/model-pages";

describe("model page routes", () => {
  const sol = { providerName: "OpenAI", slug: "gpt-5-6-sol", versionLabel: "gpt-5.6-sol" };

  it("keeps model version dots in canonical pSEO URLs", () => {
    expect(modelPagePath(sol)).toBe("/openai/gpt-5.6-sol");
    expect(modelPageSlug(sol)).toBe("gpt-5.6-sol");
  });

  it("normalizes provider names into stable path segments", () => {
    expect(providerPageSlug("Google Gemini")).toBe("google-gemini");
    expect(providerPageSlug("Mistral & Co.")).toBe("mistral-and-co");
  });

  it("never creates a scheme-relative canonical path", () => {
    const path = modelPagePath({ providerName: "---", slug: "safe-model", versionLabel: "..." });
    expect(path).toBe("/provider/safe-model");
    expect(path.startsWith("//")).toBe(false);
  });

  it("accepts the internal catalog slug so it can redirect to canonical", () => {
    expect(matchesModelPageRoute(sol, "openai", "gpt-5-6-sol")).toBe(true);
    expect(matchesModelPageRoute(sol, "anthropic", "gpt-5-6-sol")).toBe(false);
  });
});
