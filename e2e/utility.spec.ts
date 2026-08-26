import { expect, test, type Page } from "@playwright/test";
import { PROFILE_OG_IMAGE_VERSION } from "../src/lib/profile-og";
import { HOME_PAGE_DESCRIPTION, HOME_PAGE_HEADING, HOME_PAGE_TITLE } from "../src/lib/seo";

type MockIdentity = "trusted" | "suspicious" | "blocked" | "admin";

interface ItemPayload {
  id: string;
  slug: string;
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

const feedbackItems: ItemPayload[] = [
  { id: "a0f6f4a8-5e76-4c62-a224-1db4de8b1012", slug: "gpt-5-6-sol" },
  { id: "a0f6f4a8-5e76-4c62-a224-1db4de8b1013", slug: "gpt-5-6-terra" },
  { id: "a0f6f4a8-5e76-4c62-a224-1db4de8b1014", slug: "gpt-5-6-luna" }
];

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

test("the subscription utility renders without JavaScript", async ({ browser }) => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.goto("/");

  await expect(page).toHaveTitle(HOME_PAGE_TITLE);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", HOME_PAGE_DESCRIPTION);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", HOME_PAGE_TITLE);
  await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute("content", HOME_PAGE_TITLE);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://isaiokay.com/og-coding-subscription-rankings.png");
  await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", "https://isaiokay.com/og-coding-subscription-rankings.png");
  await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute("content", "1200");
  await expect(page.locator('meta[property="og:image:height"]')).toHaveAttribute("content", "630");
  await expect(page.locator('meta[name="twitter:image:alt"]')).toHaveAttribute("content", /AI coding subscriptions/i);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://isaiokay.com/");
  await expect(page.locator('link[rel="describedby"]')).toHaveAttribute("href", "https://isaiokay.com/llms.txt");
  await expect(page.getByRole("heading", { name: HOME_PAGE_HEADING })).toBeVisible();
  await expect(page.getByText("Tokens, models, effort, quota burn, and price—measured across real coding sessions. Optional check-ins tell us whether the output was worth it.", { exact: true })).toBeVisible();
  expect(await page.locator(".subscription-ranking tbody tr").count()).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".ranking-table, [data-feedback-item]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Best coding subscriptions right now" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Measure what your plan actually gives you." })).toBeVisible();
  await expect(page.getByText("npm install --global @isaiokay/cli", { exact: true })).toBeVisible();
  await expect(page.locator(".cli-step--login code")).toHaveText("isaiokay");
  await expect(page.getByRole("link", { name: "View isaiokay-com/isAIOkay on GitHub" })).toHaveAttribute("href", "https://github.com/isaiokay-com/isAIOkay");
  await expect(page.locator("#cli .github-widget")).toHaveCount(0);

  const structuredData = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() ?? "{}") as {
    "@graph"?: Array<{ "@type"?: string; name?: string }>;
  };
  expect(structuredData["@graph"]?.map((entry) => entry["@type"])).toEqual(["Organization", "WebSite", "WebPage", "Dataset"]);
  expect(structuredData["@graph"]?.find((entry) => entry["@type"] === "WebPage")?.name).toBe(HOME_PAGE_TITLE);

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

test("llms.txt describes the subscription product", async ({ request }) => {
  const response = await request.get("/llms.txt");
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("text/plain");
  const body = await response.text();
  expect(body).toContain("# IsAIokay.com");
  expect(body).toContain("[Coding subscription rankings](https://isaiokay.com/)");
  expect(body).toContain("[Sitemap](https://isaiokay.com/sitemap.xml)");
  expect(body).not.toContain("https://isaiokay.com/api/");
});

test("unknown routes use the branded 404 page", async ({ page }) => {
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("Page not found | IsAIokay.com");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  await expect(page.getByRole("heading", { name: "Page not found." })).toBeVisible();
  await expect(page.getByRole("link", { name: "View subscription rankings" })).toHaveAttribute("href", "/");
});

test("the social preview image is publicly available", async ({ request }) => {
  const response = await request.get("/og-coding-subscription-rankings.png");
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

test("subscription periods update the server-rendered ranking", async ({ page }) => {
  await page.goto("/");
  expect(await page.locator(".subscription-ranking tbody tr").count()).toBeGreaterThanOrEqual(4);
  await page.getByRole("link", { name: "30d" }).click();
  await expect(page).toHaveURL(/planPeriod=30d/);
  await expect(page.locator(".subscription-heading nav a.active")).toHaveText("30d");
  await expect(page.locator(".ranking-table, select[name='sort']")).toHaveCount(0);
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
  await expect(publicPage.getByRole("heading", { name: "Help reveal what coding subscriptions deliver." })).toBeVisible();
  await expect(publicPage.getByRole("button", { name: "Join with GitHub" })).toBeVisible();
  await expect(publicPage.getByRole("link", { name: "Explore subscription rankings" })).toHaveAttribute("href", "/#subscriptions");
  await expect(publicPage.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://isaiokay.com/u/edge-builder");
  await expect(publicPage.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex,nofollow");
  await expect(publicPage.locator('meta[property="og:type"]')).toHaveAttribute("content", "profile");
  await expect(publicPage.locator('meta[property="profile:username"]')).toHaveAttribute("content", "edge-builder");
  await expect(publicPage.locator('meta[property="og:image"]')).toHaveAttribute("content", `https://isaiokay.com/og/profile/edge-builder.png?v=${PROFILE_OG_IMAGE_VERSION}`);
  await expect(publicPage.locator('script[type="application/ld+json"]')).toHaveCount(0);
  expect(await (await publicPage.request.get("/sitemap.xml")).text()).not.toContain("https://isaiokay.com/u/edge-builder");

  const socialImage = await publicPage.request.get("/og/profile/edge-builder.png");
  expect(socialImage.ok()).toBe(true);
  expect(socialImage.headers()["content-type"]).toBe("image/png");
  expect((await socialImage.body()).byteLength).toBeGreaterThan(20_000);
  await publicPage.close();

  await expect(page.getByRole("heading", { name: "Help reveal what coding subscriptions deliver." })).toHaveCount(0);

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

test("the retained outcome API still enforces duplicate and daily limits", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "trusted");
  await expect(page.locator("[data-feedback-item], dialog.feedback-dialog")).toHaveCount(0);

  const first = await submitFeedback(page, feedbackItems[0]!.id);
  expect(first.status).toBe(201);
  expect(first.body.allowance?.remaining).toBe(1);
  const duplicate = await submitFeedback(page, feedbackItems[0]!.id);
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.code).toBe("item_already_rated");

  const second = await submitFeedback(page, feedbackItems[1]!.id);
  expect(second.status).toBe(201);
  expect(second.body.allowance?.remaining).toBe(0);

  // The third rapid request is also an abnormal-velocity event. Supplying the
  // explicit local-only mock token lets this test reach the authoritative DO
  // allowance check rather than stopping at the preceding Turnstile gate.
  const third = await submitFeedback(page, feedbackItems[2]!.id, "mock-turnstile-pass");
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

  const [item] = feedbackItems;
  const withoutToken = await submitFeedback(page, item!.id);
  expect(withoutToken.status).toBe(400);
  expect(withoutToken.body.error?.code).toBe("turnstile_required");

  const verified = await submitFeedback(page, item!.id, "mock-turnstile-pass");
  expect(verified.status).toBe(201);
});

test("a GitHub account younger than seven days cannot submit feedback", async ({ page }) => {
  await page.goto("/");
  await signInAs(page, "blocked");
  const [item] = feedbackItems;
  const result = await submitFeedback(page, item!.id, "mock-turnstile-pass");
  expect(result.status).toBe(403);
  expect(result.body.error?.code).toBe("github_account_too_new");
});

test("the subscription ranking remains usable on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Best coding subscriptions right now" })).toBeVisible();
  await expect(page.locator(".subscription-table-wrap")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.locator(".ranking-table, .mobile-cards, [data-feedback-item]")).toHaveCount(0);
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
  await expect(guide.getByRole("heading", { name: "Measure what your plan actually gives you." })).toBeVisible();
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
  await expect(stepUse.locator(".cli-command--ready > code")).toHaveText("codex");

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
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
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
