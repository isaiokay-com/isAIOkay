import { handle } from "@astrojs/cloudflare/handler";
import { FeedbackAllowance } from "./durable-objects/FeedbackAllowance";
import type { Env } from "./env";
import { PUBLIC_EDGE_CACHE_NAME } from "./lib/cache";
import { runScheduledMaintenance } from "./services/aggregation";

export { FeedbackAllowance };

const withSecurityHeaders = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "base-uri 'self'; object-src 'none'; frame-ancestors 'none'");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  if (new URL(request.url).protocol === "https:") {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const publicCacheKey = (request: Request): Request | null => {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  const isPublicAsset = /^\/og\/profile\/[^/]+\.png$/.test(url.pathname) || url.pathname === "/sitemap.xml";
  if (!isPublicAsset) return null;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
};

const withCacheStatus = (response: Response, status: "HIT" | "MISS"): Response => {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, no-cache, max-age=0, must-revalidate");
  headers.delete("cloudflare-cdn-cache-control");
  headers.set("x-isaiokay-cache", status);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const withEdgeCachePolicy = (response: Response): Response => {
  const headers = new Headers(response.headers);
  // This policy is stored only in the named Worker cache. The response sent
  // to browsers is rewritten by `withCacheStatus` to require revalidation.
  headers.set("cache-control", "public, max-age=300");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const isPubliclyCacheable = (response: Response): boolean => {
  const directive = response.headers.get("cache-control")?.toLowerCase() ?? "";
  return response.status === 200
    && directive.includes("public")
    && !directive.includes("private")
    && !directive.includes("no-store")
    && !response.headers.has("set-cookie");
};

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

// HTML is deliberately excluded: Astro server-island URLs are tied to a build
// and cannot safely survive a deployment in cached markup.
const getEdgeCache = async (): Promise<EdgeCache> => await caches.open(PUBLIC_EDGE_CACHE_NAME) as unknown as EdgeCache;

export default {
  async fetch(request, env, ctx) {
    const cacheKey = publicCacheKey(request);
    if (cacheKey) {
      try {
        const cached = await (await getEdgeCache()).match(cacheKey);
        if (cached) return withSecurityHeaders(request, withCacheStatus(cached, "HIT"));
      } catch (error) {
        console.warn("Edge response cache read failed", error);
      }
    }

    const response = withSecurityHeaders(request, await handle(request, env, ctx));
    if (!cacheKey || !isPubliclyCacheable(response)) return response;
    const edgeResponse = withEdgeCachePolicy(response);
    const cacheCopy = edgeResponse.clone();
    ctx.waitUntil(getEdgeCache().then((cache) => cache.put(cacheKey, cacheCopy)).catch((error: unknown) => {
      console.warn("Edge response cache write failed", error);
    }));
    return withCacheStatus(edgeResponse, "MISS");
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledMaintenance(env));
  }
} satisfies ExportedHandler<Env>;
