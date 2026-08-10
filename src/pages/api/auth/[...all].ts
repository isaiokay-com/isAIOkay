import type { APIRoute } from "astro";
import { createAuth } from "../../../services/auth";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getClientKey } from "../../../lib/http";
import { getRuntimeEnv } from "../../../lib/runtime";

export const prerender = false;

export const ALL: APIRoute = async (context) => {
  const env = getRuntimeEnv(context.locals);
  const url = new URL(context.request.url);
  if (url.pathname.includes("/sign-in/") || url.pathname.includes("/callback/")) {
    await enforceNamedRateLimit(env, "AUTH_RATE_LIMIT", getClientKey(context.request));
  }
  const headers = new Headers(context.request.headers);
  if (!headers.has("x-forwarded-for") && context.clientAddress) headers.set("x-forwarded-for", context.clientAddress);
  return createAuth(env).handler(new Request(context.request, { headers }));
};
