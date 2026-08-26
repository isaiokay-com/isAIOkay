import { expect, test } from "@playwright/test";

const retiredModelRoutes = [
  "/openai/gpt-5.6-sol",
  "/xai/grok-4.6",
  "/deepseek/deepseek-v4-pro",
  "/cursor/composer-2.5",
  "/kimi/kimi-k3",
  "/z-ai/glm-5.2"
] as const;

test("legacy public model-ranking routes are retired", async ({ request }) => {
  for (const path of retiredModelRoutes) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(404);
    expect(await response.text(), path).toContain("Page not found.");
  }

  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain("<loc>https://isaiokay.com/</loc>");
  for (const path of retiredModelRoutes) expect(sitemap).not.toContain(path);
});

test("legacy public model-ranking APIs are retired", async ({ request }) => {
  expect((await request.get("/api/items")).status()).toBe(404);
  expect((await request.get("/api/items/gpt-5-6-sol")).status()).toBe(404);
});
