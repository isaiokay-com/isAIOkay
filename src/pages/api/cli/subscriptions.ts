import type { APIRoute } from "astro";
import { subscriptionInputSchema } from "../../../lib/telemetry";
import { json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getClientKey } from "../../../lib/http";
import { getRuntimeEnv } from "../../../lib/runtime";
import { requireCliIdentity } from "../../../services/cli-auth";
import { listMarketSubscriptionPlans, listUserSubscriptions, upsertUserSubscription } from "../../../services/telemetry";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ALLOWANCE_RATE_LIMIT", `cli-subscriptions:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "usage:read");
    const [subscriptions, plans] = await Promise.all([
      listUserSubscriptions(env, identity.userId),
      listMarketSubscriptionPlans(env)
    ]);
    return json({ subscriptions, plans });
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "TELEMETRY_RATE_LIMIT", `cli-subscription:${getClientKey(context.request)}`);
    const identity = await requireCliIdentity(context.request, env, "subscriptions:write");
    const input = subscriptionInputSchema.parse(await context.request.json());
    return json({ subscription: await upsertUserSubscription(env, identity, input) }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
};
