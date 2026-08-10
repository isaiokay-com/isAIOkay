import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../../src/env";
import { dismissCatalogCandidate, listCatalogCandidates, promoteCatalogCandidate, upsertCatalogCandidate } from "../../src/db/repositories";
import { runCatalogDiscovery } from "../../src/services/catalog-discovery";
import { prepareTestDatabase } from "./setup";

const runtime = env as unknown as Env;
const NOW = 1_800_000_000_000;

const saveSettings = async (value: Record<string, unknown>): Promise<void> => {
  await runtime.DB.prepare(
    `insert into settings (key, value_json, updated_at, updated_by)
     values ('app', ?, ?, null)
     on conflict(key) do update set value_json = excluded.value_json, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(value), NOW).run();
};

beforeAll(async () => {
  await prepareTestDatabase(runtime);
});

describe("catalog discovery ingestion", () => {
  it("ingests provider releases as nomination-only pending candidates and deduplicates", async () => {
    await saveSettings({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [{ provider: "DeepSeek", url: "https://example.test/feeds/deepseek.json" }],
      catalogSocialDiscoveryEnabled: false,
      catalogRedditFeedUrl: ""
    });
    const fetcher = vi.fn(async () => Response.json({
      models: [
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", version: "v4", release_at: NOW, url: "https://deepseek.com/news" },
        { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }
      ]
    }));
    vi.stubGlobal("fetch", fetcher);

    const first = await runCatalogDiscovery(runtime, NOW);
    expect(first.ran).toBe(true);
    const candidates = await listCatalogCandidates(runtime, "pending");
    const candidate = candidates.find((entry) => entry.rawLabel === "deepseek-v4-flash");
    expect(candidate).toMatchObject({ status: "pending", seenCount: 2, providerName: "DeepSeek", name: "DeepSeek V4 Flash" });
    expect(candidate?.provenance.length).toBe(2);
    const itemRows = await runtime.DB.prepare("select id from tracked_item where slug = ?").bind("deepseek-v4-flash").all();
    expect(itemRows.results).toHaveLength(0);

    const second = await runCatalogDiscovery(runtime, NOW);
    expect(second.ran).toBe(true);
    const updated = (await listCatalogCandidates(runtime, "pending")).find((entry) => entry.rawLabel === "deepseek-v4-flash");
    expect(updated?.seenCount).toBe(4);
    vi.unstubAllGlobals();
  });

  it("skips an unconfigured credential-free social source without failing the run", async () => {
    await saveSettings({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [],
      catalogSocialDiscoveryEnabled: true,
      catalogRedditFeedUrl: ""
    });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await runCatalogDiscovery(runtime, NOW);
    expect(result.ran).toBe(true);
    expect(result.sources.find((source) => source.source === "reddit")?.error).toBe("reddit_feed_not_configured");
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("ingests nominations from a configured Reddit JSON feed without credentials", async () => {
    await saveSettings({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [],
      catalogSocialDiscoveryEnabled: true,
      catalogRedditFeedUrl: "https://www.reddit.com/r/LocalLLaMA/search.json?q=AI%20coding"
    });
    const fetcher = vi.fn(async () => Response.json({
      data: { children: [{ data: { title: "gemini-4-pro is available now", permalink: "/r/LocalLLaMA/comments/1/" } }] }
    }));
    vi.stubGlobal("fetch", fetcher);
    const result = await runCatalogDiscovery(runtime, NOW);
    expect(result.ran).toBe(true);
    const reddit = result.sources.find((source) => source.source === "reddit");
    expect(reddit?.candidates).toBeGreaterThan(0);
    const candidate = (await listCatalogCandidates(runtime, "pending")).find((entry) => entry.rawLabel === "gemini-4-pro");
    expect(candidate?.source).toBe("reddit");
    expect(candidate?.sourceUrl).toBe("https://www.reddit.com/r/LocalLLaMA/comments/1/");
    vi.unstubAllGlobals();
  });

  it("isolates a failing feed from a healthy feed", async () => {
    await saveSettings({
      catalogDiscoveryEnabled: true,
      catalogProviderFeeds: [
        { provider: "Broken", url: "https://example.test/broken.json" },
        { provider: "Qwen", url: "https://example.test/qwen.json" }
      ],
      catalogSocialDiscoveryEnabled: false,
      catalogRedditFeedUrl: ""
    });
    const fetcher = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/broken.json")) return new Response("", { status: 503 });
      return Response.json({ data: [{ id: "qwen3.8-max-preview", type: "model" }] });
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await runCatalogDiscovery(runtime, NOW);
    expect(result.sources[0]).toMatchObject({ source: "provider_release", error: "HTTP 503" });
    expect(result.sources[1]?.candidates).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe("catalog curation boundary", () => {
  it("promotes only through an admin flow and starts the item at Pending", async () => {
    await saveSettings({});
    const accepted = await upsertCatalogCandidate(runtime, {
      name: "nova-2-pro",
      providerName: "Example",
      type: "model",
      source: "reddit",
      sourceUrl: "https://www.reddit.com/r/LocalLLaMA/comments/1",
      rawLabel: "nova-2-pro",
      versionLabel: null,
      releaseAt: null,
      provenance: { source: "reddit", url: "https://www.reddit.com/r/LocalLLaMA/comments/1", seenAt: NOW, detail: null }
    }, NOW);
    expect(accepted).toBe(true);
    const [candidate] = (await listCatalogCandidates(runtime, "pending")).filter((entry) => entry.name === "nova-2-pro");
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Expected catalog candidate");

    const promoted = await promoteCatalogCandidate({
      env: runtime,
      candidateId: candidate.id,
      actorUserId: "admin-user",
      overrides: { officialUrl: "https://example.com/nova-2-pro" },
      now: NOW
    });
    expect(promoted.slug).toBe("nova-2-pro");
    const item = await runtime.DB.prepare(
      "select id, slug, type, is_active, sort_order from tracked_item where id = ?"
    ).bind(promoted.trackedItemId).first<{ id: string; slug: string; type: string; is_active: number; sort_order: number }>();
    expect(item).toMatchObject({ slug: "nova-2-pro", type: "model", is_active: 1 });
    const [after] = (await listCatalogCandidates(runtime, "promoted")).filter((entry) => entry.name === "nova-2-pro");
    expect(after).toBeDefined();

    await expect(promoteCatalogCandidate({
      env: runtime,
      candidateId: candidate.id,
      actorUserId: "admin-user",
      overrides: { officialUrl: "https://example.com/again" },
      now: NOW
    })).rejects.toThrow(/Only pending catalog candidates/);
  });

  it("dismisses a candidate without deleting its provenance", async () => {
    const accepted = await upsertCatalogCandidate(runtime, {
      name: "one-off-finetune-3",
      providerName: "Example",
      type: "model",
      source: "reddit",
      sourceUrl: "https://www.reddit.com/r/test",
      rawLabel: "one-off-finetune-3",
      versionLabel: null,
      releaseAt: null,
      provenance: { source: "reddit", url: "https://www.reddit.com/r/test", seenAt: NOW, detail: null }
    }, NOW);
    expect(accepted).toBe(true);
    const [candidate] = (await listCatalogCandidates(runtime, "pending")).filter((entry) => entry.name === "one-off-finetune-3");
    if (!candidate) throw new Error("Expected catalog candidate");
    await dismissCatalogCandidate({ env: runtime, candidateId: candidate.id, actorUserId: "admin-user", now: NOW });
    const [after] = (await listCatalogCandidates(runtime, "dismissed")).filter((entry) => entry.name === "one-off-finetune-3");
    expect(after?.seenCount).toBe(1);
    expect(after?.provenance.length).toBe(1);
  });
});
