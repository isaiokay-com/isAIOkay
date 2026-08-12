import { postHogHost } from "./analytics-policy";

const POSTHOG_PROXY_PREFIX = "/ph";
const forwardedRequestHeaders = ["accept", "accept-language", "content-encoding", "content-type", "user-agent"] as const;

const ingestionPath = (request: Request): string | null => {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(`${POSTHOG_PROXY_PREFIX}/`)) return null;
  const path = pathname.slice(POSTHOG_PROXY_PREFIX.length);
  return path === "/e" || path === "/e/" ? path : null;
};

/** Forward the event-ingestion route used by the bundled PostHog client. */
export const proxyPostHogIngestion = async (
  request: Request,
  configuredHost: string | undefined,
  clientAddress?: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }

  const host = postHogHost(configuredHost);
  const path = ingestionPath(request);
  if (!host || !path) return new Response("Not found", { status: 404 });

  const requestUrl = new URL(request.url);
  const upstreamUrl = new URL(path, `${host}/`);
  upstreamUrl.search = requestUrl.search;

  const headers = new Headers();
  for (const name of forwardedRequestHeaders) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const forwardedFor = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? clientAddress;
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);

  const upstreamResponse = await fetch(upstreamUrl, {
    method: "POST",
    headers,
    body: request.body,
    redirect: "manual"
  });
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.delete("content-encoding");
  responseHeaders.delete("content-length");
  responseHeaders.delete("set-cookie");
  responseHeaders.set("cache-control", "no-store");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  });
};
