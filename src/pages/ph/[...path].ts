import type { APIRoute } from "astro";
import { postHogProjectKey } from "../../lib/analytics-policy";
import { proxyPostHogIngestion } from "../../lib/posthog-proxy";
import { getRuntimeEnv } from "../../lib/runtime";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  const env = getRuntimeEnv(context.locals);
  if (!postHogProjectKey(env.POSTHOG_KEY)) return new Response("Not found", { status: 404 });
  return proxyPostHogIngestion(context.request, env.POSTHOG_HOST, context.clientAddress);
};
