import type { PublicProfileView } from "../db/repositories";

export const PROFILE_OG_IMAGE_VERSION = "3";

const OG_COLOR = {
  paper: "#F8FAFC",
  surface: "#FFFFFF",
  rule: "#DCE2EA",
  ruleStrong: "#C8D0DC",
  ink: "#0D1420",
  muted: "#59657A",
  accent: "#2563EB",
  avatarFallback: "#EFF6FF"
} as const;

const OG_FONT = {
  display: "Space Grotesk",
  body: "IBM Plex Sans"
} as const;

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

const clipped = (value: string, length: number): string => {
  const points = Array.from(value.trim());
  return points.length <= length ? value.trim() : `${points.slice(0, length - 1).join("")}…`;
};

const initials = (displayName: string): string => {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}` : words[0]?.slice(0, 2) ?? "?").toUpperCase();
};

export const bytesToDataUrl = (bytes: Uint8Array, contentType: string): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
};

export const fetchProfileAvatar = async (avatarUrl: string | null): Promise<string | null> => {
  if (!avatarUrl) return null;
  try {
    const url = new URL(avatarUrl);
    if (url.protocol !== "https:" || url.hostname !== "avatars.githubusercontent.com") return null;
    const response = await fetch(url, {
      cache: "no-store",
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
      // Cloudflare Workers supports only "follow" and "manual". Manual keeps
      // this fetch pinned to the allowlisted avatar host. The generated OG image
      // is edge-cached separately, so bypass this subrequest cache to avoid
      // retaining an old image at GitHub's stable avatar URL.
      redirect: "manual"
    });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
    if (!["image/avif", "image/webp", "image/png", "image/jpeg"].includes(contentType)) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > 2_000_000) return null;
    return bytesToDataUrl(new Uint8Array(buffer), contentType);
  } catch {
    return null;
  }
};

export const renderProfileOgSvg = (profile: PublicProfileView, avatarDataUrl: string | null): string => {
  const displayName = escapeXml(clipped(profile.displayName, 22));
  const hookName = clipped(profile.displayName, 24);
  const hookLine = `${hookName} trusts right now.`;
  const hookFontSize = hookLine.length > 38 ? 40 : hookLine.length > 30 ? 48 : hookLine.length > 24 ? 54 : 60;
  const username = escapeXml(profile.username);
  const avatar = avatarDataUrl
    ? `<image href="${avatarDataUrl}" x="96" y="442" width="92" height="92" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/><rect x="96" y="442" width="92" height="92" rx="14" fill="none" stroke="${OG_COLOR.ruleStrong}" stroke-width="2"/>`
    : `<rect x="96" y="442" width="92" height="92" rx="14" fill="${OG_COLOR.avatarFallback}" stroke="${OG_COLOR.ruleStrong}" stroke-width="2"/><text x="142" y="500" text-anchor="middle" font-family="${OG_FONT.display}" font-size="30" font-weight="700" fill="${OG_COLOR.accent}">${escapeXml(initials(profile.displayName))}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><clipPath id="avatar-clip"><rect x="96" y="442" width="92" height="92" rx="14"/></clipPath></defs>
  <rect width="1200" height="630" fill="${OG_COLOR.paper}"/>
  <rect x="56" y="44" width="1088" height="542" rx="28" fill="${OG_COLOR.surface}" stroke="${OG_COLOR.rule}" stroke-width="2"/>
  <text x="96" y="126" font-family="${OG_FONT.display}" font-size="36" font-weight="700" letter-spacing="-1.2" fill="${OG_COLOR.ink}">is<tspan fill="${OG_COLOR.accent}">AI</tspan>okay<tspan font-family="${OG_FONT.body}" font-size="23" font-weight="600" letter-spacing="-.4" fill="${OG_COLOR.muted}">.com</tspan></text>
  <circle cx="916" cy="112" r="6" fill="${OG_COLOR.accent}"/>
  <text x="934" y="118" font-family="${OG_FONT.body}" font-size="16" font-weight="600" letter-spacing="1.5" fill="${OG_COLOR.muted}">DEVELOPER PROFILE</text>
  <path d="M96 178H1104" stroke="${OG_COLOR.rule}" stroke-width="2"/>
  <text x="96" y="281" font-family="${OG_FONT.display}" font-size="60" font-weight="700" letter-spacing="-2.4" fill="${OG_COLOR.ink}">The AI coding models</text>
  <text x="96" y="351" font-family="${OG_FONT.display}" font-size="${hookFontSize}" font-weight="700" letter-spacing="-2.2" fill="${OG_COLOR.ink}">${escapeXml(hookLine)}</text>
  <path d="M96 408H1104" stroke="${OG_COLOR.rule}" stroke-width="2"/>
  ${avatar}
  <text x="216" y="481" font-family="${OG_FONT.display}" font-size="34" font-weight="700" letter-spacing="-1" fill="${OG_COLOR.ink}">${displayName}</text>
  <text x="216" y="519" font-family="${OG_FONT.body}" font-size="21" font-weight="600" fill="${OG_COLOR.accent}">@${username}</text>
  <text x="1104" y="480" text-anchor="end" font-family="${OG_FONT.body}" font-size="20" font-weight="400" fill="${OG_COLOR.muted}">Public ratings from real AI coding sessions.</text>
  <text x="1104" y="519" text-anchor="end" font-family="${OG_FONT.body}" font-size="19" font-weight="600" fill="${OG_COLOR.accent}">isaiokay.com/u/${username}</text>
</svg>`;
};
