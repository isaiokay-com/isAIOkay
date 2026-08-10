import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Repository from "../../src/db/repositories";

const { upsertCatalogCandidate } = vi.hoisted(() => ({ upsertCatalogCandidate: vi.fn(async () => true) }));

vi.mock("../../src/db/repositories", async (importOriginal) => {
  const original = await importOriginal<typeof Repository>();
  return { ...original, upsertCatalogCandidate, getSettings: vi.fn() };
});

import { extractCandidateTokens, parseProviderFeed, runCatalogDiscovery } from "../../src/services/catalog-discovery";
import { getSettings } from "../../src/db/repositories";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("catalog discovery normalization", () => {
  it("extracts API-style and human-style version tokens for known families", () => {
    expect(extractCandidateTokens("deepseek-v4-flash is out today")).toContain("deepseek-v4-flash");
    expect(extractCandidateTokens("DeepSeek V4 Flash is out today")).toContain("deepseek-v4");
    expect(extractCandidateTokens("Gemini 3.1 Pro launched with Claude 3.7 Sonnet")).toEqual(
      expect.arrayContaining(["gemini-3-1", "claude-3-7"])
    );
    expect(extractCandidateTokens("Sonnet 5 feels good")).toContain("sonnet-5");
  });

  it("never extracts opinion words, emails, or generic nouns", () => {
    const tokens = extractCandidateTokens("this model feels amazing at hello@example.com and nobody should use it");
    expect(tokens).toEqual([]);
  });

  it("deduplicates repeated identical mentions", () => {
    expect(extractCandidateTokens("claude-3-7-sonnet is great and claude-3-7-sonnet is fast")).toEqual(["claude-3-7-sonnet"]);
  });
});

describe("provider release feed parsing", () => {
  it("accepts the documented feed shapes", () => {
    const fromObject = parseProviderFeed({
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", version: "v4", release_at: 1_800_000_000_000, url: "https://deepseek.com/news" }]
    }, "DeepSeek");
    expect(fromObject[0]).toMatchObject({
      providerName: "DeepSeek",
      type: "model",
      rawLabel: "deepseek-v4-flash",
      versionLabel: "v4",
      releaseAt: 1_800_000_000_000
    });

    const fromArray = parseProviderFeed([{ id: "qwen3.8-max-preview", type: "agent" }], "Qwen");
    expect(fromArray[0]).toMatchObject({ name: "qwen3.8-max-preview", type: "agent" });
  });

  it("skips entries without a name or provider identity", () => {
    expect(parseProviderFeed([{ version: "v1" }], "Provider")).toHaveLength(0);
    expect(parseProviderFeed([{ id: "model-x" }], "  ")).toHaveLength(0);
  });

  it("ignores malformed release timestamps", () => {
    const parsed = parseProviderFeed([{ id: "m-1", release_at: "not-a-date" }], "P");
    expect(parsed[0]?.releaseAt).toBeNull();
  });
});

describe("scheduled discovery isolation", () => {
  it("returns a disabled run without touching the network", async () => {
    vi.mocked(getSettings).mockResolvedValue({ catalogDiscoveryEnabled: false, catalogProviderFeeds: [], catalogSocialDiscoveryEnabled: false, catalogRedditFeedUrl: "" } as never);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = {} as never;
    const result = await runCatalogDiscovery(env, 1_800_000_000_000);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("catalog_discovery_disabled");
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("isolates a failing feed so other sources still run", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [
        { provider: "Broken", url: "https://example.test/broken.json" },
        { provider: "Good", url: "https://example.test/good.json" }
      ],
      catalogSocialDiscoveryEnabled: false,
      catalogRedditFeedUrl: ""
    } as never);
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/broken.json")) return { ok: false, status: 500 } as Response;
      return Response.json({ models: [{ id: "good-model-2", url: "https://example.test/good" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const env = {} as never;
    const result = await runCatalogDiscovery(env, 1_800_000_000_000);
    expect(result.ran).toBe(true);
    expect(result.sources[0]).toMatchObject({ source: "provider_release", candidates: 0, error: "HTTP 500" });
    expect(result.sources[1]?.candidates).toBe(1);
    expect(upsertCatalogCandidate).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("rejects local network feed addresses before fetch", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [{ provider: "Unsafe", url: "https://127.0.0.1/models.json" }],
      catalogSocialDiscoveryEnabled: false,
      catalogRedditFeedUrl: ""
    } as never);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await runCatalogDiscovery({} as never, 1_800_000_000_000);
    expect(result.sources[0]?.error).toBe("Local discovery sources are not allowed");
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("stops reading an oversized chunked feed", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [{ provider: "Large", url: "https://example.test/large.json" }],
      catalogSocialDiscoveryEnabled: false,
      catalogRedditFeedUrl: ""
    } as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1_048_577))));
    const result = await runCatalogDiscovery({} as never, 1_800_000_000_000);
    expect(result.sources[0]?.error).toBe("Discovery response is too large");
    expect(upsertCatalogCandidate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports social sources as skipped when they are not configured", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [],
      catalogSocialDiscoveryEnabled: true,
      catalogRedditFeedUrl: ""
    } as never);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const env = {} as never;
    const result = await runCatalogDiscovery(env, 1_800_000_000_000);
    const reddit = result.sources.find((source) => source.source === "reddit");
    expect(reddit?.error).toBe("reddit_feed_not_configured");
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
