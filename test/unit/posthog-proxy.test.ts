import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyPostHogIngestion } from "../../src/lib/posthog-proxy";

afterEach(() => vi.restoreAllMocks());

describe("PostHog ingestion proxy", () => {
  it("forwards event ingestion to the configured region without browser cookies", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain", "set-cookie": "upstream=unsafe" }
    }));
    const request = new Request("https://isaiokay.com/ph/e/?ip=1", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "203.0.113.4",
        "content-type": "application/json",
        cookie: "private=session"
      },
      body: "{}"
    });

    const response = await proxyPostHogIngestion(request, "https://us.i.posthog.com");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(String(target)).toBe("https://us.i.posthog.com/e/?ip=1");
    expect(new Headers(init?.headers).get("cookie")).toBeNull();
    expect(new Headers(init?.headers).get("x-forwarded-for")).toBe("203.0.113.4");
  });

  it("rejects unsupported paths, methods, and hosts", async () => {
    await expect(proxyPostHogIngestion(new Request("https://isaiokay.com/ph/static/client.js"), undefined))
      .resolves.toMatchObject({ status: 405 });
    await expect(proxyPostHogIngestion(new Request("https://isaiokay.com/ph/decide", { method: "POST" }), undefined))
      .resolves.toMatchObject({ status: 404 });
    await expect(proxyPostHogIngestion(new Request("https://isaiokay.com/ph/e/", { method: "POST" }), "https://attacker.example"))
      .resolves.toMatchObject({ status: 404 });
  });
});
