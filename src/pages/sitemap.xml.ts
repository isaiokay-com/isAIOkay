import type { APIRoute } from "astro";

export const prerender = false;

const routes = ["/"];

export const GET: APIRoute = () => {
  const staticUrls = routes.map((route) => `<url><loc>https://isaiokay.com${route}</loc></url>`);
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${staticUrls.join("")}</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" } }
  );
};
