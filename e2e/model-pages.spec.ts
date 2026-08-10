import { expect, test } from "@playwright/test";

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
  expect(await sitemap.text()).toContain("https://isaiokay.com/openai/gpt-5.6-sol");
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
