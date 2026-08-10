import type { Env } from "../env";
import { getSettings } from "../db/repositories";
import { upsertCatalogCandidate, type CatalogCandidateInput } from "../db/repositories";
import { normalizeModelLabel } from "../lib/cli";
import { isSafeHttpsUrl } from "../lib/security";

export type DiscoverySource = "provider_release" | "reddit" | "cli" | "admin";

export interface DiscoveryProvenance {
  source: DiscoverySource;
  url: string | null;
  seenAt: number;
  detail: string | null;
}

/**
 * Conservative social extraction. It recognizes version-bearing tokens from
 * known provider families, both as API-style identifiers ("deepseek-v4-flash")
 * and as human-style family + version forms ("DeepSeek V4", "Gemini 3.1").
 * It never parses an opinion or attributes sentiment; the result is
 * nomination-only and still requires an administrator to activate it.
 */
const CANDIDATE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgpt-?[\w.-]*\d[\w.-]*\b/gi,
  /\bgpt\s+v?\d[\w.-]*\b/gi,
  /\bo[34]-?[\w.-]+\b/gi,
  /\bclaude-?[\w.-]*\d[\w.-]*\b/gi,
  /\bclaude\s+\d[\w.-]*\b/gi,
  /\b(?:opus|sonnet|haiku)-?[\w.-]*\d[\w.-]*\b/gi,
  /\b(?:opus|sonnet|haiku)\s+\d[\w.-]*\b/gi,
  /\bgemini-?[\w.-]*\d[\w.-]*\b/gi,
  /\bgemini\s+v?\d[\w.-]*\b/gi,
  /\bdeepseek-?[\w.-]*\d[\w.-]*\b/gi,
  /\bdeepseek\s+v?\d[\w.-]*\b/gi,
  /\bqwen-?[\w.-]*\d[\w.-]*\b/gi,
  /\bqwen\s+v?\d[\w.-]*\b/gi,
  /\bgrok-?[\w.-]*\d[\w.-]*\b/gi,
  /\bgrok\s+v?\d[\w.-]*\b/gi,
  /\bcodex-?[\w.-]*\d[\w.-]*\b/gi,
  /\bcodex\s+v?\d[\w.-]*\b/gi
];

export const extractCandidateTokens = (text: string): string[] => {
  const seen = new Set<string>();
  for (const pattern of CANDIDATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[0]?.trim();
      if (!candidate) continue;
      const normalized = normalizeModelLabel(candidate);
      if (normalized.length >= 3 && normalized.length <= 80 && !seen.has(normalized)) seen.add(normalized);
    }
  }
  return [...seen];
};

/** A conservative timestamp parser: epoch milliseconds or an ISO date string. */
const asTimestamp = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 1e11) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value.trim());
    return Number.isFinite(parsed) && parsed > 1e11 ? parsed : null;
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstString = (entry: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
};

/**
 * Accepted provider release feed shapes:
 * - a JSON array of entries;
 * - `{ models: [...] }`, `{ items: [...] }`, `{ releases: [...] }`, or `{ data: [...] }`.
 *
 * Entry fields: `id`, `name`, `provider`, `type` ("model" | "agent"), `version`,
 * `release_at`, and `url`/`source_url`. The feed's configured `provider` is the
 * fallback provider identity; it is never guessed from the model name.
 */
export const parseProviderFeed = (value: unknown, fallbackProvider: string): CatalogCandidateInput[] => {
  const rawEntries: unknown[] = [];
  if (Array.isArray(value)) rawEntries.push(...value);
  else if (isRecord(value)) {
    for (const key of ["models", "items", "releases", "data"]) {
      const list = value[key];
      if (Array.isArray(list)) {
        rawEntries.push(...list);
        break;
      }
    }
  }
  const entries: CatalogCandidateInput[] = [];
  for (const raw of rawEntries) {
    if (!isRecord(raw)) continue;
    const name = firstString(raw, ["name"]) ?? firstString(raw, ["id"]);
    if (!name) continue;
    const rawProvider = firstString(raw, ["provider", "provider_name", "providerId"]);
    const provider = (rawProvider ?? fallbackProvider).trim();
    if (!provider) continue;
    const type = raw.type === "agent" ? "agent" : "model";
    const sourceUrlValue = firstString(raw, ["url", "source_url", "release_url", "permalink"]);
    const sourceUrl = sourceUrlValue && isSafeHttpsUrl(sourceUrlValue) ? sourceUrlValue : null;
    const versionLabel = firstString(raw, ["version", "version_label", "versionLabel"]);
    const rawLabel = firstString(raw, ["id", "model_id", "modelId"]) ?? name;
    entries.push({
      name: name.slice(0, 80),
      providerName: provider.slice(0, 80),
      type,
      source: "provider_release",
      sourceUrl,
      rawLabel: rawLabel.slice(0, 160),
      versionLabel: versionLabel?.slice(0, 80) ?? null,
      releaseAt: asTimestamp(raw.release_at ?? raw.releaseAt ?? raw.releasedAt),
      provenance: { source: "provider_release", url: sourceUrl, seenAt: Date.now(), detail: `provider feed ${fallbackProvider}` }
    });
  }
  return entries;
};

export interface DiscoverySourceResult {
  source: DiscoverySource;
  candidates: number;
  error?: string;
}

export interface DiscoveryRunResult {
  ran: boolean;
  reason?: string;
  sources: DiscoverySourceResult[];
}

const fetchJson = async (url: string, init?: RequestInit): Promise<unknown> => {
  if (!isSafeHttpsUrl(url)) throw new Error("Only credential-free HTTPS discovery sources are allowed");
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = hostname.split(".").map(Number);
  const privateIpv4 = ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && (
    ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0]! >= 224
    || (ipv4[0] === 100 && ipv4[1]! >= 64 && ipv4[1]! <= 127)
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168)
    || (ipv4[0] === 198 && (ipv4[1] === 18 || ipv4[1] === 19))
  );
  const privateIpv6 = hostname === "::" || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || /^fe[89ab]/.test(hostname) || hostname.startsWith("::ffff:");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || privateIpv4 || privateIpv6) {
    throw new Error("Local discovery sources are not allowed");
  }
  const response = await globalThis.fetch(parsed.toString(), { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 1_048_576) throw new Error("Discovery response is too large");
  if (!response.body) throw new Error("Discovery response is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > 1_048_576) {
      await reader.cancel();
      throw new Error("Discovery response is too large");
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body) as unknown;
};

const MAX_PROVENANCE_ENTRIES = 10;

const ingestCandidates = async (env: Env, candidates: CatalogCandidateInput[], now: number): Promise<number> => {
  let inserted = 0;
  for (const candidate of candidates) {
    const accepted = await upsertCatalogCandidate(env, candidate, now, MAX_PROVENANCE_ENTRIES);
    if (accepted) inserted += 1;
  }
  return inserted;
};

const ingestProviderFeed = async (env: Env, provider: string, url: string, now: number): Promise<DiscoverySourceResult> => {
  try {
    const parsed = await fetchJson(url);
    const candidates = parseProviderFeed(parsed, provider).map((candidate) => ({
      ...candidate,
      provenance: { ...candidate.provenance, seenAt: now }
    }));
    return { source: "provider_release", candidates: await ingestCandidates(env, candidates, now) };
  } catch (error) {
    return { source: "provider_release", candidates: 0, error: error instanceof Error ? error.message : "unknown_feed_error" };
  }
};

/**
 * Optional Reddit discovery from a configured public JSON listing/search URL.
 * No credentials are required or embedded; rate limits belong to the host.
 */
const ingestRedditDiscoveries = async (env: Env, feedUrl: string, now: number): Promise<DiscoverySourceResult> => {
  if (!feedUrl) return { source: "reddit", candidates: 0, error: "reddit_feed_not_configured" };
  try {
    const parsed = await fetchJson(feedUrl, {
      headers: { "user-agent": "isaiokay-catalog-discovery/0.1 (nomination-only)" }
    });
    const children = isRecord(parsed) && isRecord(parsed.data) && Array.isArray(parsed.data.children) ? parsed.data.children : [];
    const candidates: CatalogCandidateInput[] = [];
    for (const child of children) {
      if (!isRecord(child) || !isRecord(child.data)) continue;
      const title = typeof child.data.title === "string" ? child.data.title : "";
      const permalink = typeof child.data.permalink === "string" ? child.data.permalink : null;
      const urlValue = permalink ? `https://www.reddit.com${permalink}` : null;
      for (const token of extractCandidateTokens(title)) {
        candidates.push({
          name: token,
          providerName: "Unknown (verify)",
          type: "model",
          source: "reddit",
          sourceUrl: urlValue,
          rawLabel: token,
          versionLabel: null,
          releaseAt: null,
          provenance: { source: "reddit", url: urlValue, seenAt: now, detail: null }
        });
      }
    }
    return { source: "reddit", candidates: await ingestCandidates(env, candidates, now) };
  } catch (error) {
    return { source: "reddit", candidates: 0, error: error instanceof Error ? error.message : "unknown_reddit_error" };
  }
};

/**
 * Nomination-only scheduled discovery. Every source is isolated: one failing
 * feed can never block aggregation or another source. Social sources are
 * optional and require an explicit settings flag plus credentials/URL.
 */
export const runCatalogDiscovery = async (env: Env, now = Date.now()): Promise<DiscoveryRunResult> => {
  const settings = await getSettings(env);
  if (!settings.catalogDiscoveryEnabled) return { ran: false, reason: "catalog_discovery_disabled", sources: [] };
  const sources: DiscoverySourceResult[] = [];
  for (const feed of settings.catalogProviderFeeds) {
    sources.push(await ingestProviderFeed(env, feed.provider, feed.url, now));
  }
  if (settings.catalogSocialDiscoveryEnabled) {
    sources.push(await ingestRedditDiscoveries(env, settings.catalogRedditFeedUrl, now));
  }
  return { ran: true, sources };
};
