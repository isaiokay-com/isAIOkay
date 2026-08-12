import { expect, test } from "@playwright/test";

const newModelPages = [
  ["/xai/grok-4.6", "Grok 4.6"],
  ["/deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"],
  ["/cursor/composer-2.5", "Composer 2.5"],
  ["/kimi/kimi-k3", "Kimi K3"],
  ["/kimi/kimi-k2.7-code", "Kimi K2.7 Code"],
  ["/z-ai/glm-5.2", "GLM-5.2"],
  ["/minimax/minimax-m3", "MiniMax M3"],
  ["/qwen/qwen3.8-max", "Qwen 3.8 Max"]
] as const;

test("serves canonical provider/model history pages", async ({ page, request }) => {
  await page.goto("/");
  const homeRow = page.locator("#item-gpt-5-6-sol");
  await expect(homeRow.locator(".rank-item-link")).toHaveAttribute("href", "/openai/gpt-5.6-sol");
  await expect(homeRow.getByRole("link", { name: "Quick view" })).toHaveAttribute("href", /item=gpt-5-6-sol/);

  await page.setViewportSize({ width: 375, height: 900 });
  const mobileCard = page.locator(".mobile-card-shell").filter({ has: page.locator("#mobile-gpt-5-6-sol") });
  const mobileHistoryLink = mobileCard.getByRole("link", { name: "View full history for GPT-5.6 Sol" });
  await expect(mobileHistoryLink).toBeVisible();
  await expect(mobileHistoryLink).toHaveAttribute("href", "/openai/gpt-5.6-sol");

  await page.goto("/openai/gpt-5.6-sol");

  await expect(page).toHaveTitle("GPT-5.6 Sol Developer Experience Ratings | IsAIokay.com");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", "See how GPT-5.6 Sol ranks with developers. Explore daily result quality, usage efficiency, confidence, and signs of improvement or degradation.");
  await expect(page.getByRole("heading", { level: 1, name: "GPT-5.6 Sol" })).toBeVisible();
  await expect(page.getByText("Tracked since", { exact: true })).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://isaiokay.com/openai/gpt-5.6-sol");
  await expect(page.getByRole("heading", { name: "Developer Signal over time" })).toBeVisible();
  await expect(page.getByText("No completed daily snapshot yet")).toBeVisible();

  const legacy = await request.get("/openai/gpt-5-6-sol", { maxRedirects: 0 });
  expect(legacy.status()).toBe(301);
  expect(legacy.headers().location).toBe("/openai/gpt-5.6-sol");

  const sitemap = await request.get("/sitemap.xml");
  const sitemapXml = await sitemap.text();
  expect(sitemapXml).toContain("https://isaiokay.com/openai/gpt-5.6-sol");
  for (const [path] of newModelPages) expect(sitemapXml).toContain(`https://isaiokay.com${path}`);
});

test("serves every newly tracked model pSEO page", async ({ request }) => {
  for (const [path, modelName] of newModelPages) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const html = await response.text();
    expect(html, path).toContain(`<h1 id="model-title">${modelName}</h1>`);
    expect(html, path).toContain(`<link rel="canonical" href="https://isaiokay.com${path}">`);
  }

  const qwenPreview = await request.get("/qwen/qwen3.8-max-preview", { maxRedirects: 0 });
  expect(qwenPreview.status()).toBe(301);
  expect(qwenPreview.headers().location).toBe("/qwen/qwen3.8-max");
});

test("model page has no horizontal document overflow at supported widths", async ({ page }) => {
  await page.goto("/openai/gpt-5.6-sol");
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const dimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
  }
});
