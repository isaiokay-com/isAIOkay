import { describe, expect, it, vi } from "vitest";
import type { PublicProfileView } from "../../src/db/repositories";
import { bytesToDataUrl, fetchProfileAvatar, renderProfileOgSvg } from "../../src/lib/profile-og";

const profile: PublicProfileView = {
  userId: "user-1",
  username: "andfk",
  displayName: "Test & Developer",
  avatarUrl: "https://avatars.githubusercontent.com/u/1377735?v=4",
  xUsername: "andfkdev",
  isPublic: true,
  isOwner: false,
  reportCount: 12,
  mostUsedModels: [{ name: "Claude Sonnet <5>", slug: "claude-sonnet-5", reports: 4 }],
  reports: [],
  ratingsNextCursor: null
};

describe("profile social images", () => {
  it("renders a 1200 by 630 identity card without rating totals", () => {
    const svg = renderProfileOgSvg(profile, "data:image/png;base64,YXZhdGFy");

    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain("Test &amp; Developer");
    expect(svg).toContain("Test &amp; Developer trusts right now.");
    expect(svg).toContain("isaiokay.com/u/andfk");
    expect(svg).toContain('href="data:image/png;base64,YXZhdGFy"');
    expect(svg).toContain('<rect x="56" y="44" width="1088" height="542" rx="28"');
    expect(svg).toContain('<rect x="96" y="442" width="92" height="92" rx="14"');
    expect(svg).not.toContain("Claude Sonnet &lt;5&gt;");
    expect(svg).not.toContain(">12</text>");
    expect(svg).not.toContain("MOST REPORTED");
    expect(svg).not.toContain("<script");
  });

  it("uses developer initials when no avatar is available", () => {
    const svg = renderProfileOgSvg(profile, null);
    expect(svg).toContain(">TD<");
    expect(svg).not.toContain("<image");
  });

  it("encodes fetched image bytes as an inline data URL", () => {
    expect(bytesToDataUrl(new Uint8Array([97, 118, 97, 116, 97, 114]), "image/png")).toBe("data:image/png;base64,YXZhdGFy");
  });

  it("bypasses the subrequest cache when fetching GitHub avatars", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([97, 118, 97]), {
      headers: { "content-type": "image/png" }
    }));

    try {
      await expect(fetchProfileAvatar(profile.avatarUrl)).resolves.toBe("data:image/png;base64,YXZh");
      expect(fetchMock).toHaveBeenCalledWith(new URL(profile.avatarUrl!), expect.objectContaining({
        cache: "no-store",
        redirect: "manual"
      }));
    } finally {
      fetchMock.mockRestore();
    }
  });
});
