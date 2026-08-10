import { describe, expect, it } from "vitest";
import type { PublicProfileView } from "../../src/db/repositories";
import { bytesToDataUrl, renderProfileOgSvg } from "../../src/lib/profile-og";

const profile: PublicProfileView = {
  userId: "user-1",
  username: "andfk",
  displayName: "Andrés & Team",
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
    expect(svg).toContain("Andrés &amp; Team");
    expect(svg).toContain("isaiokay.com/u/andfk");
    expect(svg).toContain('href="data:image/png;base64,YXZhdGFy"');
    expect(svg).not.toContain("Claude Sonnet &lt;5&gt;");
    expect(svg).not.toContain(">12</text>");
    expect(svg).not.toContain("MOST REPORTED");
    expect(svg).not.toContain("<script");
  });

  it("uses developer initials when no avatar is available", () => {
    const svg = renderProfileOgSvg(profile, null);
    expect(svg).toContain(">AT<");
    expect(svg).not.toContain("<image");
  });

  it("encodes fetched image bytes as an inline data URL", () => {
    expect(bytesToDataUrl(new Uint8Array([97, 118, 97, 116, 97, 114]), "image/png")).toBe("data:image/png;base64,YXZhdGFy");
  });
});
