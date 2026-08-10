import type { RankingItem } from "../types";

type ModelRouteSource = Pick<RankingItem, "providerName" | "slug" | "versionLabel">;

const routeSegment = (value: string, preserveDots = false): string => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .trim()
  .toLowerCase()
  .replace(/&/g, " and ")
  .replace(preserveDots ? /[^a-z0-9.]+/g : /[^a-z0-9]+/g, "-")
  .replace(/-+/g, "-")
  .replace(/\.{2,}/g, ".")
  .replace(/^[.-]+|[.-]+$/g, "");

export const providerPageSlug = (providerName: string): string => routeSegment(providerName) || "provider";

export const modelPageSlug = (item: Pick<ModelRouteSource, "slug" | "versionLabel">): string =>
  routeSegment(item.versionLabel?.trim() || item.slug, true) || routeSegment(item.slug, true) || "model";

export const modelPagePath = (item: ModelRouteSource): string =>
  `/${providerPageSlug(item.providerName)}/${modelPageSlug(item)}`;

export const matchesModelPageRoute = (
  item: ModelRouteSource,
  provider: string,
  model: string
): boolean => providerPageSlug(item.providerName) === providerPageSlug(provider)
  && (modelPageSlug(item) === routeSegment(model, true) || routeSegment(item.slug, true) === routeSegment(model, true));
