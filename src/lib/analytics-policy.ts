const POSTHOG_HOSTS = new Set([
  "https://us.i.posthog.com",
  "https://eu.i.posthog.com"
]);

const modelPagePattern = /^\/[a-z0-9-]+\/[a-z0-9.-]+\/?$/;
const privateRouteRoots = new Set(["admin", "api", "cli", "ph", "u"]);
const publicProjectKeyPattern = /^phc_[A-Za-z0-9_-]{10,}$/;

/** Analytics is limited to the public ranking and canonical model pages. */
export const isAnalyticsPath = (pathname: string): boolean => {
  if (pathname === "/") return true;
  const routeRoot = pathname.split("/")[1];
  return typeof routeRoot === "string" && routeRoot.length > 0 && !privateRouteRoots.has(routeRoot) && modelPagePattern.test(pathname);
};

export const postHogHost = (configuredHost: string | undefined): string | null => {
  const normalized = configuredHost?.trim().replace(/\/$/, "") || "https://us.i.posthog.com";
  return POSTHOG_HOSTS.has(normalized) ? normalized : null;
};

/** Only public project keys may ever be embedded into rendered HTML. */
export const postHogProjectKey = (configuredKey: string | undefined): string | null => {
  const normalized = configuredKey?.trim() ?? "";
  return publicProjectKeyPattern.test(normalized) ? normalized : null;
};

/** Keep campaign properties while preventing query strings or fragments from entering URL fields. */
export const publicAnalyticsUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
};
