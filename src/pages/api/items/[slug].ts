import type { APIRoute } from "astro";
import { getItemBySlug } from "../../../db/repositories";
import { loadPublicRanking } from "../../../lib/cache";
import { getRuntimeEnv } from "../../../lib/runtime";
import { json, toErrorResponse } from "../../../lib/http";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    const fromCache = (await loadPublicRanking(env, "live")).payload.items.find((item) => item.slug === context.params.slug);
    const item = fromCache ?? await getItemBySlug(env, context.params.slug ?? "");
    if (!item) return json({ error: { code: "not_found", message: "Item not found." } }, { status: 404 });
    return json(item, { headers: { "cache-control": "public, max-age=60, s-maxage=300" } });
  } catch (error) {
    return toErrorResponse(error);
  }
};
