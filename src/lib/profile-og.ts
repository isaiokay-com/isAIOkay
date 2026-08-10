import type { PublicProfileView } from "../db/repositories";

const OG_COLOR = {
  paper: "#F8FAFD",
  paperAccent: "#EEF3FF",
  rule: "#DDE3EC",
  ink: "#182033",
  muted: "#59657A",
  accent: "#315EDE",
  avatarFallback: "#E8EEFF"
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
      headers: { accept: "image/avif,image/webp,image/png,image/jpeg" },
      // Cloudflare Workers supports only "follow" and "manual". Manual keeps
      // this fetch pinned to the allowlisted avatar host.
      redirect: "manual",
      cf: { cacheEverything: true, cacheTtl: 86_400 }
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
  const displayName = escapeXml(clipped(profile.displayName, 34));
  const username = escapeXml(profile.username);
  const avatar = avatarDataUrl
    ? `<image href="${avatarDataUrl}" x="78" y="180" width="188" height="188" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatar-clip)"/>`
    : `<circle cx="172" cy="274" r="94" fill="${OG_COLOR.avatarFallback}"/><text x="172" y="291" text-anchor="middle" font-family="${OG_FONT.display}" font-size="48" font-weight="700" fill="${OG_COLOR.accent}">${escapeXml(initials(profile.displayName))}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><clipPath id="avatar-clip"><circle cx="172" cy="274" r="94"/></clipPath></defs>
  <rect width="1200" height="630" fill="${OG_COLOR.paper}"/>
  <circle cx="1080" cy="-20" r="250" fill="${OG_COLOR.paperAccent}"/>
  <path d="M0 124H1200M0 496H1200" stroke="${OG_COLOR.rule}" stroke-width="2"/>
  <text x="72" y="79" font-family="${OG_FONT.display}" font-size="32" font-weight="700" fill="${OG_COLOR.ink}">isAIokay<tspan fill="${OG_COLOR.accent}">.com</tspan></text>
  <text x="1128" y="78" text-anchor="end" font-family="${OG_FONT.body}" font-size="18" font-weight="400" letter-spacing="2.4" fill="${OG_COLOR.muted}">DEVELOPER MODEL FEEDBACK</text>
  ${avatar}
  <circle cx="243" cy="345" r="17" fill="${OG_COLOR.accent}" stroke="${OG_COLOR.paper}" stroke-width="6"/>
  <path d="m236 345 5 5 10-12" fill="none" stroke="${OG_COLOR.paper}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="312" y="216" font-family="${OG_FONT.body}" font-size="25" font-weight="400" fill="${OG_COLOR.accent}">@${username}</text>
  <text x="312" y="300" font-family="${OG_FONT.display}" font-size="68" font-weight="700" letter-spacing="-2.4" fill="${OG_COLOR.ink}">${displayName}</text>
  <text x="312" y="349" font-family="${OG_FONT.body}" font-size="24" font-weight="400" fill="${OG_COLOR.muted}">Public ratings from real AI coding sessions.</text>
  <text x="1128" y="575" text-anchor="end" font-family="${OG_FONT.body}" font-size="20" font-weight="400" fill="${OG_COLOR.accent}">isaiokay.com/u/${username}</text>
</svg>`;
};
