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
    expect(providerPageSlug("Z.ai")).toBe("z-ai");
  });

  it.each([
    ["Grok 4.6", "xAI", "grok-4-6", "grok-4.6", "/xai/grok-4.6"],
    ["DeepSeek V4 Pro", "DeepSeek", "deepseek-v4-pro", "deepseek-v4-pro", "/deepseek/deepseek-v4-pro"],
    ["Composer 2.5", "Cursor", "composer-2-5", "composer-2.5", "/cursor/composer-2.5"],
    ["Kimi K3", "Kimi", "kimi-k3", "kimi-k3", "/kimi/kimi-k3"],
    ["Kimi K2.7 Code", "Kimi", "kimi-k2-7-code", "kimi-k2.7-code", "/kimi/kimi-k2.7-code"],
    ["GLM-5.2", "Z.ai", "glm-5-2", "glm-5.2", "/z-ai/glm-5.2"],
    ["MiniMax M3", "MiniMax", "minimax-m3", "minimax-m3", "/minimax/minimax-m3"],
    ["Qwen 3.8 Max", "Qwen", "qwen-3-8-max", "qwen3.8-max", "/qwen/qwen3.8-max"]
  ])("builds the canonical catalog route for %s", (_name, providerName, slug, versionLabel, expected) => {
    expect(modelPagePath({ providerName, slug, versionLabel })).toBe(expected);
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
