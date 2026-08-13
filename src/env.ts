/** Cloudflare bindings used by the Astro Worker and Durable Objects. */
export interface Env {
  DB: D1Database;
  PUBLIC_CACHE: KVNamespace;
  FEEDBACK_ALLOWANCE: DurableObjectNamespace;
  AUTH_RATE_LIMIT: RateLimitBinding;
  FEEDBACK_MODAL_RATE_LIMIT: RateLimitBinding;
  FEEDBACK_RATE_LIMIT: RateLimitBinding;
  ALLOWANCE_RATE_LIMIT: RateLimitBinding;
  ADMIN_RATE_LIMIT: RateLimitBinding;
  BETTER_AUTH_SECRET: string;
  /** Stable anti-re-registration pepper. Unlike auth secrets, this must never rotate. */
  DELETED_IDENTITY_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  MOCK_GITHUB_AUTH?: string;
  ADMIN_GITHUB_USER_IDS?: string;
}

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
