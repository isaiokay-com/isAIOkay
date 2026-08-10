import type { APIRoute } from "astro";
import { listPublicModelSitemapEntries, listPublicProfileSitemapEntries } from "../db/repositories";
import { modelPagePath } from "../lib/model-pages";
import { getRuntimeEnv } from "../lib/runtime";

export const prerender = false;

const routes = ["/"];
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const GET: APIRoute = async ({ locals }) => {
  const env = getRuntimeEnv(locals);
  const [models, profiles] = await Promise.all([
    listPublicModelSitemapEntries(env),
    listPublicProfileSitemapEntries(env)
  ]);
  const staticUrls = routes.map((route) => `<url><loc>https://isaiokay.com${route}</loc></url>`);
  const modelUrls = models.map((model) => `<url><loc>${xml(`https://isaiokay.com${modelPagePath(model)}`)}</loc><lastmod>${new Date(model.updatedAt).toISOString()}</lastmod></url>`);
  const profileUrls = profiles.map((profile) => `<url><loc>${xml(`https://isaiokay.com/u/${encodeURIComponent(profile.username)}`)}</loc><lastmod>${new Date(profile.updatedAt).toISOString()}</lastmod></url>`);
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...staticUrls, ...modelUrls, ...profileUrls].join("")}</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }
  );
};
