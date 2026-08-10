import { describe, expect, it, vi } from "vitest";
import { readRankingCache } from "../../src/lib/cache";
import type { Env } from "../../src/env";

describe("public ranking cache", () => {
  it("treats KV errors as a cache miss so callers can use D1", async () => {
    const env = {
      PUBLIC_CACHE: { get: vi.fn().mockRejectedValue(new Error("KV unavailable")) }
    } as unknown as Env;
    await expect(readRankingCache(env, "7d")).resolves.toBeNull();
  });

  it("rejects malformed cached payloads", async () => {
    const get = vi.fn().mockResolvedValueOnce({ schemaVersion: 2, generatedAt: "not-a-date", expiresAt: "also-bad", items: [] });
    const env = { PUBLIC_CACHE: { get } } as unknown as Env;
    await expect(readRankingCache(env, "7d")).resolves.toBeNull();
  });
});
