import type { APIRoute } from "astro";
import { z } from "zod";
import { billingPeriodSchema } from "../../../lib/telemetry";
import { getClientKey, HttpError, json, toErrorResponse } from "../../../lib/http";
import { enforceNamedRateLimit } from "../../../lib/rate-limit";
import { getRuntimeEnv } from "../../../lib/runtime";
import { httpsUrlSchema } from "../../../lib/security";
import { requireAdministrator } from "../../../services/auth";

export const prerender = false;

const createPlanSchema = z.object({
  action: z.literal("create_plan"),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  providerName: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(100),
  billingPeriod: billingPeriodSchema,
  priceMicros: z.number().int().min(0).max(1_000_000_000_000).nullable(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  officialUrl: httpsUrlSchema,
  termsVersion: z.string().trim().min(1).max(80),
  termsLastVerifiedAt: z.number().int().positive()
}).strict();

const deactivatePlanSchema = z.object({ action: z.literal("deactivate_plan"), planId: z.uuid() }).strict();

const createPriceSchema = z.object({
  action: z.literal("create_price"),
  providerName: z.string().trim().min(1).max(80),
  modelKey: z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+\-#]*$/),
  displayName: z.string().trim().min(1).max(100),
  inputMicrosPerMillion: z.number().int().min(0),
  cacheReadMicrosPerMillion: z.number().int().min(0),
  cacheWriteMicrosPerMillion: z.number().int().min(0),
  outputMicrosPerMillion: z.number().int().min(0),
  reasoningMicrosPerMillion: z.number().int().min(0),
  sourceUrl: httpsUrlSchema,
  effectiveFrom: z.number().int().positive()
}).strict();

const closePriceSchema = z.object({
  action: z.literal("close_price"),
  priceId: z.uuid(),
  effectiveTo: z.number().int().positive()
}).strict();

const actionSchema = z.discriminatedUnion("action", [createPlanSchema, deactivatePlanSchema, createPriceSchema, closePriceSchema]);

export const GET: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    await requireAdministrator(context.request, env);
    const [plans, prices] = await Promise.all([
      env.DB.prepare("select * from subscription_plan order by is_active desc, provider_name, name, created_at desc").all(),
      env.DB.prepare("select * from model_price order by provider_name, model_key, effective_from desc").all()
    ]);
    return json({ plans: plans.results, prices: prices.results });
  } catch (error) {
    return toErrorResponse(error);
  }
};

export const POST: APIRoute = async (context) => {
  try {
    const env = getRuntimeEnv(context.locals);
    await enforceNamedRateLimit(env, "ADMIN_RATE_LIMIT", getClientKey(context.request));
    const identity = await requireAdministrator(context.request, env);
    const input = actionSchema.parse(await context.request.json());
    const now = Date.now();
    const id = crypto.randomUUID();
    if (input.action === "create_plan") {
      const existing = await env.DB.prepare("select id from subscription_plan where slug = ? limit 1")
        .bind(input.slug).first<{ id: string }>();
      if (existing) throw new HttpError(409, "subscription_plan_exists", "A subscription plan already uses that slug.");
      await env.DB.batch([
        env.DB.prepare(
          `insert into subscription_plan
            (id, slug, provider_name, name, billing_period, price_micros, currency, official_url,
             terms_version, terms_last_verified_at, is_active, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).bind(id, input.slug, input.providerName, input.name, input.billingPeriod, input.priceMicros, input.currency, input.officialUrl, input.termsVersion, input.termsLastVerifiedAt, now, now),
        env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, after_json, created_at) values (?, ?, 'create_subscription_plan', 'subscription_plan', ?, ?, ?)")
          .bind(crypto.randomUUID(), identity.userId, id, JSON.stringify(input), now)
      ]);
      return json({ ok: true, id }, { status: 201 });
    }
    if (input.action === "deactivate_plan") {
      const existing = await env.DB.prepare("select id from subscription_plan where id = ? and is_active = 1 limit 1")
        .bind(input.planId).first<{ id: string }>();
      if (!existing) throw new HttpError(404, "subscription_plan_not_active", "That active subscription plan does not exist.");
      await env.DB.batch([
        env.DB.prepare("update subscription_plan set is_active = 0, updated_at = ? where id = ?").bind(now, input.planId),
        env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, after_json, created_at) values (?, ?, 'deactivate_subscription_plan', 'subscription_plan', ?, ?, ?)")
          .bind(crypto.randomUUID(), identity.userId, input.planId, JSON.stringify({ isActive: false }), now)
      ]);
      return json({ ok: true });
    }
    if (input.action === "create_price") {
      const overlapping = await env.DB.prepare(
        `select id from model_price
         where lower(provider_name) = lower(?) and lower(model_key) = lower(?)
           and (effective_to is null or effective_to > ?) limit 1`
      ).bind(input.providerName, input.modelKey, input.effectiveFrom).first<{ id: string }>();
      if (overlapping) {
        throw new HttpError(409, "model_price_overlap", "Close the existing price interval before adding its replacement.");
      }
      await env.DB.batch([
        env.DB.prepare(
          `insert into model_price
            (id, provider_name, model_key, display_name, input_micros_per_million,
             cache_read_micros_per_million, cache_write_micros_per_million,
             output_micros_per_million, reasoning_micros_per_million, source_url,
             effective_from, effective_to, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`
        ).bind(id, input.providerName, input.modelKey, input.displayName, input.inputMicrosPerMillion,
          input.cacheReadMicrosPerMillion, input.cacheWriteMicrosPerMillion,
          input.outputMicrosPerMillion, input.reasoningMicrosPerMillion,
          input.sourceUrl, input.effectiveFrom, now),
        env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, after_json, created_at) values (?, ?, 'create_model_price', 'model_price', ?, ?, ?)")
          .bind(crypto.randomUUID(), identity.userId, id, JSON.stringify(input), now)
      ]);
      return json({ ok: true, id }, { status: 201 });
    }
    const closed = await env.DB.prepare(
      "update model_price set effective_to = ? where id = ? and effective_to is null and effective_from < ?"
    ).bind(input.effectiveTo, input.priceId, input.effectiveTo).run();
    if (!closed.meta.changes) throw new HttpError(409, "model_price_not_closeable", "That price interval is missing, already closed, or ends before it starts.");
    await env.DB.prepare("insert into audit_log (id, actor_user_id, action, entity_type, entity_id, after_json, created_at) values (?, ?, 'close_model_price', 'model_price', ?, ?, ?)")
      .bind(crypto.randomUUID(), identity.userId, input.priceId, JSON.stringify({ effectiveTo: input.effectiveTo }), now).run();
    return json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
};
