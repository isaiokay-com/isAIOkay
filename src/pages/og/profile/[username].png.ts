import { Resvg } from "@cf-wasm/resvg/workerd";
import type { APIRoute } from "astro";
import ibmPlexRegularDataUrl from "@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2?inline";
import spaceGroteskBoldDataUrl from "@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2?inline";
import { getPublicProfileView } from "../../../db/repositories";
import { fetchProfileAvatar, renderProfileOgSvg } from "../../../lib/profile-og";
import { getRuntimeEnv } from "../../../lib/runtime";

export const prerender = false;

const dataUrlToBytes = (value: string): Uint8Array => {
  const [, encoded = ""] = value.split(",", 2);
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const fontBuffers = [dataUrlToBytes(spaceGroteskBoldDataUrl), dataUrlToBytes(ibmPlexRegularDataUrl)];

export const GET: APIRoute = async ({ locals, params }) => {
  const env = getRuntimeEnv(locals);
  const profile = await getPublicProfileView(env, params.username ?? "", null);
  if (!profile?.isPublic) {
    return new Response("Profile image not found", {
      status: 404,
      headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" }
    });
  }

  const avatarDataUrl = await fetchProfileAvatar(profile.avatarUrl);
  const svg = renderProfileOgSvg(profile, avatarDataUrl);
  const renderer = await Resvg.async(svg, {
    fitTo: { mode: "original" },
    font: { fontBuffers, loadSystemFonts: false }
  });
  const png = renderer.render().asPng();
  renderer.free();

  return new Response(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer, {
    headers: {
      "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
      "content-type": "image/png",
      "content-length": String(png.byteLength),
      "x-content-type-options": "nosniff"
    }
  });
};
