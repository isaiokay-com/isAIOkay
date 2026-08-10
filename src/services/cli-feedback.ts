import type { Env } from "../env";
import type { CliFeedbackInput } from "../lib/cli";
import { normalizeModelLabel, toolFallbackSlug } from "../lib/cli";
import { HttpError } from "../lib/http";
import { upsertCatalogCandidate } from "../db/repositories";

export interface CliTrackedItem {
  id: string;
  slug: string;
  name: string;
  providerName: string;
  type: "model" | "agent";
}

/**
 * Attribution strength is derived by the server from the tool's documented
 * integration surface. Client input may only downgrade it to mixed/opaque/
 * unknown, never promote a provider to a stronger guarantee.
 */
export const deriveCliAttribution = (input: CliFeedbackInput): CliFeedbackInput["attribution"] => {
  if (input.confirmedItemSlug) return "user_confirmed";
  if (input.attribution === "mixed" || input.attribution === "opaque_router" || input.attribution === "unknown") {
    return input.attribution;
  }
  switch (input.tool) {
    case "codex": return "verified_active";
    case "claude-code": return "verified_start_only";
    case "cursor":
    case "opencode":
    case "gemini-cli":
    case "cline":
    case "windsurf":
    case "amp": return "model_at_end";
    case "copilot-cli":
    case "aider":
    case "grok-build":
    case "muse-code":
    case "other": return "unknown";
  }
};

const getItemBySlug = async (env: Env, slug: string): Promise<CliTrackedItem | null> => env.DB.prepare(
  `select id, slug, name, provider_name as providerName, type
   from tracked_item where slug = ? and is_active = 1 limit 1`
).bind(slug).first<CliTrackedItem>();

export const listCliTrackedItems = async (env: Env): Promise<CliTrackedItem[]> => {
  const rows = await env.DB.prepare(
    `select id, slug, name, provider_name as providerName, type
     from tracked_item where is_active = 1 and type = 'model' order by sort_order asc, name asc`
  ).all<CliTrackedItem>();
  return rows.results;
};

export const resolveCliAgentItemId = async (env: Env, input: CliFeedbackInput): Promise<string | null> => {
  const slug = toolFallbackSlug(input.tool);
  if (!slug) return null;
  const agent = await getItemBySlug(env, slug);
  return agent?.type === "agent" ? agent.id : null;
};

export const resolveCliTrackedItem = async (env: Env, input: CliFeedbackInput): Promise<{
  item: CliTrackedItem;
  attribution: CliFeedbackInput["attribution"];
}> => {
  const attribution = deriveCliAttribution(input);
  if (input.confirmedItemSlug) {
    const confirmed = await getItemBySlug(env, input.confirmedItemSlug);
    if (!confirmed || confirmed.type !== "model") throw new HttpError(422, "unknown_confirmed_item", "The selected model is not available.");
    return { item: confirmed, attribution };
  }

  if (attribution === "verified_start_only") {
    throw new HttpError(422, "model_confirmation_required", "Confirm the Claude model because it may have changed after the session started.");
  }

  const normalized = input.rawModelLabel ? normalizeModelLabel(input.rawModelLabel) : null;
  if (normalized && attribution !== "opaque_router" && attribution !== "mixed" && attribution !== "unknown") {
    const alias = await env.DB.prepare(
      `select ti.id, ti.slug, ti.name, ti.provider_name as providerName, ti.type
       from model_alias ma join tracked_item ti on ti.id = ma.tracked_item_id
       where ma.tool = ? and ma.normalized_label = ? and ti.is_active = 1 and ti.type = 'model' limit 1`
    ).bind(input.tool, normalized).first<CliTrackedItem>();
    if (alias) return { item: alias, attribution };

    const exact = await env.DB.prepare(
      `select id, slug, name, provider_name as providerName, type from tracked_item
       where is_active = 1 and type = 'model' and (slug = ? or lower(name) = lower(?) or lower(coalesce(version_label, '')) = lower(?)) limit 1`
    ).bind(normalized, input.rawModelLabel, input.rawModelLabel).first<CliTrackedItem>();
    if (exact) return { item: exact, attribution };
  }

  if (normalized && input.rawModelLabel && attribution !== "opaque_router" && attribution !== "mixed" && attribution !== "unknown") {
    const now = Date.now();
    try {
      await upsertCatalogCandidate(env, {
        name: input.rawModelLabel.slice(0, 80),
        providerName: "Unknown (verify)",
        type: "model",
        source: "cli",
        sourceUrl: null,
        rawLabel: input.rawModelLabel.slice(0, 160),
        versionLabel: null,
        releaseAt: null,
        provenance: { source: "cli", url: null, seenAt: now, detail: `unresolved ${input.tool} label` }
      }, now);
    } catch (error) {
      console.warn("Could not nominate unresolved CLI model label", error);
    }
  }

  const candidates = await listCliTrackedItems(env);
  throw new HttpError(422, "model_confirmation_required", "Confirm which model produced this session before submitting. The coding agent is recorded separately.", {
    detectedLabel: input.rawModelLabel ?? null,
    candidates: candidates.map(({ slug, name, providerName, type }) => ({ slug, name, providerName, type }))
  });
};
