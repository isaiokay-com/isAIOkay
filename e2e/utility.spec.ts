import { expect, test, type Page } from "@playwright/test";
import { PROFILE_OG_IMAGE_VERSION } from "../src/lib/profile-og";
import { HOME_PAGE_DESCRIPTION, HOME_PAGE_HEADING, HOME_PAGE_TITLE } from "../src/lib/seo";

type MockIdentity = "trusted" | "suspicious" | "blocked" | "admin";

interface ItemPayload {
  id: string;
  slug: string;
  type?: string;
  developerCount?: number;
  rankChange?: number | null;
}

interface FeedbackResult {
  status: number;
  body: {
    accepted?: boolean;
    code?: string;
    error?: { code?: string; message?: string };
    allowance?: { remaining: number; alreadyRatedItemIds: string[] };
  };
}

test.describe.configure({ mode: "serial" });

const signInAs = async (page: Page, identity: MockIdentity): Promise<void> => {
  const result = await page.evaluate(async (selectedIdentity) => {
    const response = await fetch("/api/dev/mock-github", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: selectedIdentity })
    });
    return { status: response.status, body: await response.json() };
  }, identity);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ ok: true });
};

const rankedItems = async (page: Page): Promise<ItemPayload[]> => page.evaluate(async () => {
  const response = await fetch("/api/items?period=7d", { credentials: "same-origin" });
  const payload = await response.json() as { items: ItemPayload[] };
  return payload.items;
});

const submitFeedback = async (page: Page, trackedItemId: string, turnstileToken?: string): Promise<FeedbackResult> => page.evaluate(async ({ itemId, token }) => {
  const response = await fetch("/api/feedback", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      trackedItemId: itemId,
      resultQualityRating: 4,
      usageEfficiencyRating: 4,
      tags: ["e2e"],
      shortComment: "Playwright local development report",
      turnstileToken: token,
      deviceId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID()
    })
  });
  return { status: response.status, body: await response.json() };
}, { itemId: trackedItemId, token: turnstileToken });

const waitForFeedbackIsland = async (page: Page): Promise<void> => {
  await page.locator("dialog.feedback-dialog").waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const island = document.querySelector<HTMLElement>('astro-island[component-url*="FeedbackDialog"]');
    return Boolean(island && !island.hasAttribute("ssr"));
  });
};

test("the public utility renders and expands without JavaScript", async ({ browser }) => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.goto("/");

  await expect(page).toHaveTitle(HOME_PAGE_TITLE);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", HOME_PAGE_DESCRIPTION);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", HOME_PAGE_TITLE);
  await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute("content", HOME_PAGE_TITLE);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://isaiokay.com/og-ai-coding-model-rankings.png");
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", "https://isaiokay.com/og-ai-coding-model-rankings.png");
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute("content", "1200");
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute("content", "630");
  await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute("content", /AI coding model rankings/i);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://isaiokay.com/");
  await expect(page.locator('link[rel="describedby"]')).toHaveAttribute("href", "https://isaiokay.com/llms.txt");
  await expect(page.getByRole("heading", { name: HOME_PAGE_HEADING })).toBeVisible();
  await expect(page.getByText("Real developers set the ranking. No lab scores. No synthetic benchmarks.", { exact: true })).toBeVisible();
  expect(await page.locator(".ranking-table .ranking-row").count()).toBeGreaterThanOrEqual(5);
  await expect(page.getByRole("button", { name: "Live" })).toHaveAttribute("data-active", "true");
  await expect(page.getByRole("heading", { name: "Report from your terminal." })).toBeVisible();
  await expect(page.getByText("npm install --global @isaiokay/cli", { exact: true })).toBeVisible();
  await expect(page.locator(".cli-step--login code")).toHaveText("isaiokay");
  await expect(page.getByRole("link", { name: "View isaiokay-com/isAIOkay on GitHub" })).toHaveAttribute("href", "https://github.com/isaiokay-com/isAIOkay");
  await expect(page.locator("#cli .github-widget")).toHaveCount(0);

  const structuredData = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() ?? "{}") as {
    "@graph"?: Array<{ "@type"?: string; name?: string }>;
  };
  expect(structuredData["@graph"]?.map((entry) => entry["@type"])).toEqual(["Organization", "WebSite", "WebPage", "Dataset"]);
  expect(structuredData["@graph"]?.find((entry) => entry["@type"] === "WebPage")?.name).toBe(HOME_PAGE_TITLE);

  const firstItem = page.locator(".ranking-table .ranking-row .rank-quick-view").first();
  await firstItem.click();
  await expect(page).toHaveURL(/item=/);
  await expect(page.getByText("Recent experience evidence")).toBeVisible();
  await page.close();
});

test("private utility pages are noindex and omit public structured data", async ({ page }) => {
  await page.goto("/cli/authorize");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
});

test("legal drafts are noindex and excluded from the sitemap", async ({ page, request }) => {
  for (const path of ["/privacy", "/terms"]) {
    await page.goto(path);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  }
  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).not.toContain("https://isaiokay.com/privacy");
  expect(sitemap).not.toContain("https://isaiokay.com/terms");
});

test("llms.txt is a concise public index for language models", async ({ request }) => {
  const response = await request.get("/llms.txt");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/plain");
  const body = await response.text();
  expect(body).toContain("# IsAIokay.com");
  expect(body).toContain("[Live AI coding model rankings](https://isaiokay.com/)");
  expect(body).toContain("[Sitemap](https://isaiokay.com/sitemap.xml)");
  expect(body).not.toContain("https://isaiokay.com/api/");
});

test("unknown routes use the branded 404 page", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("Page not found | IsAIokay.com");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();
  await expect(page.getByRole("link", { name: "View model rankings" })).toHaveAttribute("href", "/");
});

test("the social preview image is publicly available", async ({ request }) => {
  const response = await request.get("/og-ai-coding-model-rankings.png");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toBe("image/png");
  expect((await response.body()).byteLength).toBeGreaterThan(40_000);
});

test("responses include baseline browser security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});

test("model period and sorting controls update the server-rendered ranking", async ({ page }) => {
  await page.goto("/");
  expect(await page.locator(".ranking-table .ranking-row").count()).toBeGreaterThanOrEqual(5);
  await expect(page.getByRole("button", { name: "Agents" })).toHaveCount(0);
  expect((await rankedItems(page)).every((item) => item.type === "model")).toBe(true);

  await page.getByRole("button", { name: "24 hours" }).click();
  await expect(page).toHaveURL(/period=24h/);
  await page.locator('select[name="sort"]').selectOption("result");
  await expect(page).toHaveURL(/sort=result/);
});

test("a GitHub profile remains private and supports an optional self-declared X link", async ({ page, browser }) => {
  await page.goto("/");
  await signInAs(page, "trusted");
  await page.goto("/u/edge-builder");
  await expect(page.getByRole("heading", { name: "Edge Builder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit profile" })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  await page.getByRole("button", { name: "Edit profile" }).click();
  const settings = page.getByRole("dialog", { name: "Profile settings" });
  await expect(settings).toBeVisible();
  await settings.getByLabel(/X username/).fill("edge_builder");
  await settings.getByLabel("Public ratings").check();
  await Promise.all([
    page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame()),
    settings.getByRole("button", { name: "Save changes" }).click()
  ]);
  await expect(page.getByRole("link", { name: "Open @edge_builder on X (self-declared)" })).toBeVisible();

  const publicPage = await browser.newPage();
  await publicPage.goto("/u/edge-builder");
  await expect(publicPage.getByRole("heading", { name: "Edge Builder" })).toBeVisible();
  await expect(publicPage.getByRole("link", { name: "Open edge-builder on GitHub" })).toBeVisible();
  await expect(publicPage.getByRole("link", { name: "Open @edge_builder on X (self-declared)" })).toBeVisible();
  await expect(publicPage.getByRole("button", { name: "Edit profile" })).toHaveCount(0);
  await expect(publicPage.getByRole("tab")).toHaveCount(0);
  await expect(publicPage.getByRole("heading", { name: "Ratings", exact: true })).toBeVisible();
  await expect(publicPage.getByText(/Only structured ratings are shown/)).toBeVisible();
  await expect(publicPage.getByRole("heading", { name: "Your experience belongs in the ranking." })).toBeVisible();
  await expect(publicPage.getByRole("button", { name: "Join with GitHub" })).toBeVisible();
  await expect(publicPage.getByRole("link", { name: "Explore live rankings" })).toHaveAttribute("href", "/#ranking");
  await expect(publicPage.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://isaiokay.com/u/edge-builder");
  await expect(publicPage.locator('meta[property="og:type"]')).toHaveAttribute("content", "profile");
  await expect(publicPage.locator('meta[property="profile:username"]')).toHaveAttribute("content", "edge-builder");
  await expect(publicPage.locator('meta[property="og:image"]')).toHaveAttribute("content", `https://isaiokay.com/og/profile/edge-builder.png?v=${PROFILE_OG_IMAGE_VERSION}`);
  const structuredData = JSON.parse(await publicPage.locator('script[type="application/ld+json"]').textContent() ?? "{}") as {
    mainEntity?: { image?: string; sameAs?: string[] };
  };
  expect(structuredData.mainEntity?.sameAs).toEqual(["https://github.com/edge-builder", "https://x.com/edge_builder"]);
  expect(await (await publicPage.request.get("/sitemap.xml")).text()).toContain("https://isaiokay.com/u/edge-builder");

  const socialImage = await publicPage.request.get("/og/profile/edge-builder.png");
  expect(socialImage.ok()).toBe(true);
  expect(socialImage.headers()["content-type"]).toBe("image/png");
  expect((await socialImage.body()).byteLength).toBeGreaterThan(20_000);
  await publicPage.close();

  await expect(page.getByRole("heading", { name: "Your experience belongs in the ranking." })).toHaveCount(0);

  await page.getByRole("button", { name: "Edit profile" }).click();
  await settings.getByLabel("Public ratings").uncheck();
  await Promise.all([
    page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame()),
    settings.getByRole("button", { name: "Save changes" }).click()
  ]);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  expect((await page.request.get("/og/profile/edge-builder.png")).status()).toBe(404);
  expect(await (await page.request.get("/sitemap.xml")).text()).not.toContain("https://isaiokay.com/u/edge-builder");
});

test("anonymous rating opens a sign-in control", async ({ page }) => {
  await page.goto("/");
  await waitForFeedbackIsland(page);
  await page.locator(".ranking-row [data-feedback-item]").first().click();
  await expect(page.getByText("Feedback is tied to a GitHub identity to keep the signal useful.")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("the rating dialog fits supported viewport widths", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "trusted");
  await page.reload();
  await waitForFeedbackIsland(page);

  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("[data-feedback-item]").first().dispatchEvent("click");
    const feedbackDialog = page.getByRole("dialog");
    await expect(feedbackDialog).toBeVisible();
    const bounds = await feedbackDialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await feedbackDialog.getByRole("button", { name: "Close feedback dialog" }).click();
  }
});

test("a trusted user can submit two reports while duplicate and third reports are blocked", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "trusted");
  await page.reload();
  await expect(page.getByLabel("Feedback allowance")).toHaveText("2 ratings available");
  const items = await rankedItems(page);
  expect(items.length).toBeGreaterThanOrEqual(5);
  expect(items.every((item) => Number.isInteger(item.developerCount) && (item.rankChange === null || Number.isInteger(item.rankChange)))).toBe(true);

  // Exercise the interactive form once; the remaining allowance tests verify
  // the actual API contract in the same authenticated browser context.
  await waitForFeedbackIsland(page);
  const firstRate = page.locator(".ranking-row [data-feedback-item]").first();
  const submittedSlug = await firstRate.getAttribute("data-feedback-item");
  const submittedItem = items.find((item) => item.slug === submittedSlug);
  const remainingItems = items.filter((item) => item.slug !== submittedSlug);
  expect(submittedItem).toBeDefined();
  expect(remainingItems.length).toBeGreaterThanOrEqual(2);
  await firstRate.click();
  const feedbackDialog = page.getByRole("dialog");
  await expect(feedbackDialog).toBeVisible();
  let submittedAnswers: Record<string, unknown> | null = null;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/feedback")) {
      submittedAnswers = request.postDataJSON() as Record<string, unknown>;
    }
  });
  await feedbackDialog.getByText("Add context").click();
  await feedbackDialog.locator('select[name="agentItemId"]').selectOption({ label: "Cursor" });
  await feedbackDialog.getByLabel("Result quality: 5 out of 5").check();
  await feedbackDialog.getByLabel("Usage efficiency: 2 out of 5").check();
  await feedbackDialog.getByRole("button", { name: "Save rating" }).click();
  await expect(feedbackDialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Rating saved" })).toContainText("1 remaining today");
  expect(submittedAnswers).toMatchObject({
    agentItemId: "a0f6f4a8-5e76-4c62-a224-1db4de8b1005",
    resultQualityRating: 5,
    usageEfficiencyRating: 2,
    tags: []
  });

  await page.getByRole("button", { name: "Edit once · 10 min" }).click();
  await expect(feedbackDialog).toBeVisible();
  await expect(feedbackDialog.locator("#feedback-title")).toContainText(/^Edit /);
  await expect(feedbackDialog.getByLabel("Result quality: 5 out of 5")).toBeChecked();
  await expect(feedbackDialog.getByLabel("Usage efficiency: 2 out of 5")).toBeChecked();
  let editedAnswers: Record<string, unknown> | null = null;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && request.url().endsWith("/api/feedback")) {
      editedAnswers = request.postDataJSON() as Record<string, unknown>;
    }
  });
  await feedbackDialog.getByLabel("Result quality: 4 out of 5").check();
  await feedbackDialog.getByRole("button", { name: "Update rating" }).click();
  await expect(feedbackDialog).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Rating updated" })).toBeVisible();
  expect(editedAnswers).toMatchObject({ resultQualityRating: 4, usageEfficiencyRating: 2 });
  await expect(page.getByRole("button", { name: "Edit once · 10 min" })).toHaveCount(0);

  const duplicate = await submitFeedback(page, submittedItem!.id);
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe("item_already_rated");

  const second = await submitFeedback(page, remainingItems[0]!.id);
  expect(second.status).toBe(201);
  expect(second.body.allowance?.remaining).toBe(0);

  // The third rapid request is also an abnormal-velocity event. Supplying the
  // explicit local-only mock token lets this test reach the authoritative DO
  // allowance check rather than stopping at the preceding Turnstile gate.
  const third = await submitFeedback(page, remainingItems[1]!.id, "mock-turnstile-pass");
  expect(third.status).toBe(429);
  expect(third.body.code).toBe("allowance_exhausted");
});

test("a suspicious account requires development Turnstile verification", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "suspicious");
  const modal = await page.evaluate(async () => {
    const response = await fetch("/api/feedback", { credentials: "same-origin" });
    return { status: response.status, body: await response.json() };
  });
  expect(modal.status).toBe(200);
  expect(modal.body).toMatchObject({ authenticated: true, requiresTurnstile: true });

  const [item] = await rankedItems(page);
  const withoutToken = await submitFeedback(page, item!.id);
  expect(withoutToken.status).toBe(400);
  expect(withoutToken.body.error?.code).toBe("turnstile_required");

  const verified = await submitFeedback(page, item!.id, "mock-turnstile-pass");
  expect(verified.status).toBe(201);
});

test("a GitHub account younger than seven days cannot submit feedback", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "blocked");
  const [item] = await rankedItems(page);
  const result = await submitFeedback(page, item!.id, "mock-turnstile-pass");
  expect(result.status).toBe(403);
  expect(result.body.error?.code).toBe("github_account_too_new");
});

test("mobile cards are usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const firstCard = page.locator(".mobile-cards details").first();
  await expect(firstCard).toBeVisible();
  await firstCard.locator("summary").click();
  await expect(firstCard.getByLabel(/\d+% confidence/)).toBeVisible();
  await expect(firstCard.getByRole("link", { name: /Rate/ })).toBeVisible();
});

test("the CLI guide progressively reveals steps as the user copies commands", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as typeof window & { __copiedCliCommand?: string }).__copiedCliCommand = value;
        }
      }
    });
  });
  await page.goto("/#cli");
  const guide = page.locator("#cli");
  await expect(guide.getByRole("heading", { name: "Report from your terminal." })).toBeVisible();
  await expect(guide.locator(".cli-step")).toHaveCount(3);

  const stepOnboarding = guide.locator(".cli-step--login");
  const stepUse = guide.locator(".cli-step--run");
  await expect(stepOnboarding).toBeHidden();
  await expect(stepUse).toBeHidden();

  await expect(guide.locator("[data-cli-install-command]")).toHaveText("npm install --global @isaiokay/cli");
  await guide.getByRole("tab", { name: "pnpm" }).click();
  await expect(guide.locator("[data-cli-install-command]")).toHaveText("pnpm add --global @isaiokay/cli");
  await guide.getByRole("tab", { name: "Bun" }).click();
  await expect(guide.locator("[data-cli-install-command]")).toHaveText("bun add --global @isaiokay/cli");

  await guide.getByRole("button", { name: "Copy install command" }).click();
  await expect(guide.getByRole("button", { name: "Copy install command" })).toHaveText("Copied");
  expect(await page.evaluate(() => (window as typeof window & { __copiedCliCommand?: string }).__copiedCliCommand)).toBe("bun add --global @isaiokay/cli");

  await expect(stepOnboarding).toBeVisible();
  await expect(stepUse).toBeHidden();

  await guide.getByRole("button", { name: "Copy onboarding command" }).click();
  await expect(guide.getByRole("button", { name: "Copy onboarding command" })).toHaveText("Copied");
  await expect(stepUse).toBeVisible();
  await expect(stepUse.locator("code")).toHaveText("codex");

  await guide.getByText("More setup options").click();
  await expect(guide.getByText("isaiokay setup --headless")).toBeVisible();
  await expect(guide.getByText("isaiokay install --all")).toBeVisible();
  await expect(guide.getByText("npx --yes @isaiokay/cli --help")).toBeVisible();

  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});

test("an administrator can moderate a submitted report", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "admin");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Moderation" })).toBeVisible();
  await page.getByLabel("Version label").fill("e2e-release");
  await page.getByLabel("Release date").fill("2030-01-01");
  await page.getByLabel("Official release source").fill("https://example.com/releases/e2e");
  await page.getByRole("button", { name: "Save release reference" }).click();
  await expect(page.getByText("Release reference saved. A qualifying baseline will be collected prospectively.")).toBeVisible();
  await page.getByLabel("Version label").fill("");
  await page.getByLabel("Release date").fill("");
  await page.getByLabel("Official release source").fill("");
  await page.getByRole("button", { name: "Save release reference" }).click();
  await expect(page.getByText("Release reference saved. A qualifying baseline will be collected prospectively.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Version label")).toHaveValue("");
  await expect(page.getByLabel("Release date")).toHaveValue("");
  await expect(page.getByLabel("Official release source")).toHaveValue("");
  await expect(page.locator("[aria-label='Feedback moderation'] tbody tr").first()).toBeVisible();
  await page.getByRole("button", { name: "Exclude" }).first().click();
  await expect(page.locator("[aria-label='Feedback moderation'] tbody tr").first().getByText("excluded")).toBeVisible();
});

test("an authenticated user can explicitly approve a CLI device code", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "trusted");
  const started = await page.evaluate(async () => {
    const response = await fetch("/api/cli/device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "Playwright CLI" })
    });
    return response.json() as Promise<{ deviceCode: string; userCode: string }>;
  });
  await page.goto(`/cli/authorize?user_code=${encodeURIComponent(started.userCode)}`);
  await page.getByRole("button", { name: "Approve this CLI" }).click();
  await expect(page.getByRole("heading", { name: "CLI connected" })).toBeVisible();
  await expect(page.getByText("Return to your terminal to continue. You can safely close this tab.")).toBeVisible();
  await expect(page.getByLabel("Code shown by the CLI")).toBeHidden();
  await expect(page.getByRole("button", { name: "Approve this CLI" })).toBeHidden();
  const token = await page.evaluate(async (deviceCode) => {
    const response = await fetch("/api/cli/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode })
    });
    return { status: response.status, body: await response.json() as { accessToken?: string } };
  }, started.deviceCode);
  expect(token.status).toBe(200);
  expect(token.body.accessToken).toMatch(/^iai_[a-f0-9]{64}$/);
});

test("a suspicious CLI user completes browser verification and submits with the one-time proof", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "suspicious");
  const linked = await page.evaluate(async () => {
    const startResponse = await fetch("/api/cli/device/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "Playwright suspicious CLI" })
    });
    return startResponse.json() as Promise<{ deviceCode: string; userCode: string }>;
  });
  await page.goto(`/cli/authorize?user_code=${encodeURIComponent(linked.userCode)}`);
  await page.getByRole("button", { name: "Approve this CLI" }).click();
  await expect(page.getByRole("heading", { name: "CLI connected" })).toBeVisible();
  const accessToken = await page.evaluate(async (deviceCode) => {
    const response = await fetch("/api/cli/device/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode })
    });
    const body = await response.json() as { accessToken: string };
    return body.accessToken;
  }, linked.deviceCode);

  const prepared = await page.evaluate(async (token) => {
    const headers = { authorization: `Bearer ${token}` };
    const [allowanceResponse, itemsResponse] = await Promise.all([
      fetch("/api/cli/allowance", { headers }),
      fetch("/api/cli/items", { headers })
    ]);
    const allowance = await allowanceResponse.json() as { alreadyRatedItemIds: string[] };
    const catalog = await itemsResponse.json() as { items: Array<{ id: string; slug: string }> };
    return catalog.items.find(({ id }) => !allowance.alreadyRatedItemIds.includes(id))!;
  }, accessToken);
  const payload = {
    tool: "opencode",
    confirmedItemSlug: prepared.slug,
    attribution: "user_confirmed",
    adapterVersion: "0.1.0",
    sessionHash: "e".repeat(64),
    sessionDurationBucket: "10_30m",
    resultQualityRating: 2,
    usageEfficiencyRating: 3,
    tags: ["e2e-cli"],
    clientEventId: crypto.randomUUID()
  };
  const challenge = await page.evaluate(async ({ token, body }) => {
    const response = await fetch("/api/cli/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() as { error: { code: string; details: { challengeId: string; verificationUrl: string } } } };
  }, { token: accessToken, body: payload });
  expect(challenge.status).toBe(428);
  expect(challenge.body.error.code).toBe("cli_verification_required");

  await page.goto(challenge.body.error.details.verificationUrl);
  await page.getByRole("button", { name: "Complete verification" }).click();
  await expect(page.getByText("Verified. Return to the terminal; the CLI will retry automatically.")).toBeVisible();
  const proof = await page.evaluate(async ({ token, challengeId }) => {
    const response = await fetch(`/api/cli/challenges/${challengeId}`, { headers: { authorization: `Bearer ${token}` } });
    return response.json() as Promise<{ challengeProof: string }>;
  }, { token: accessToken, challengeId: challenge.body.error.details.challengeId });
  expect(proof.challengeProof).toMatch(/^[a-f0-9]{64}$/);

  const submitted = await page.evaluate(async ({ token, body, challengeId, challengeProof }) => {
    const response = await fetch("/api/cli/feedback", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, challengeId, challengeProof })
    });
    return { status: response.status, body: await response.json() as { accepted?: boolean } };
  }, {
    token: accessToken,
    body: payload,
    challengeId: challenge.body.error.details.challengeId,
    challengeProof: proof.challengeProof
  });
  expect(submitted.status).toBe(201);
  expect(submitted.body.accepted).toBe(true);
});

test("an account owner can permanently remove their account", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "blocked");
  await page.goto("/u/very-new-dev");
  await page.getByRole("button", { name: "Edit profile" }).click();
  const settings = page.getByRole("dialog", { name: "Profile settings" });
  await settings.getByRole("button", { name: "Delete account" }).click();
  const deletionDialog = page.getByRole("dialog", { name: "Delete account" });
  await expect(deletionDialog).toBeVisible();
  const confirmation = deletionDialog.getByLabel(/Type very-new-dev to confirm/);
  const submit = deletionDialog.getByRole("button", { name: "Delete my account" });
  await expect(submit).toBeDisabled();
  await confirmation.fill("very-new");
  await expect(submit).toBeDisabled();
  await confirmation.fill("very-new-dev");
  await submit.click();
  await expect(page).toHaveURL(/\?account=deleted/);
  await expect(page.getByRole("status")).toContainText("Your account was deleted.");
  await page.goto("/u/very-new-dev");
  await expect(page.getByRole("heading", { name: "This profile is private" })).toBeVisible();
  const reRegistration = await page.evaluate(async () => {
    const response = await fetch("/api/dev/mock-github", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: "blocked" })
    });
    return { status: response.status, body: await response.json() as { error?: { code?: string } } };
  });
  expect(reRegistration).toMatchObject({ status: 403, body: { error: { code: "account_deleted" } } });
});
