import { env as cloudflareEnv } from "cloudflare:workers";
import type { Env } from "../env";

/**
 * Astro 6+ exposes Cloudflare runtime bindings through `cloudflare:workers`.
 * The binding is request-scoped by workerd; callers still create Better Auth
 * from it per request instead of using a process-global auth/database client.
 */
export const getRuntimeEnv = (_locals?: unknown): Env => cloudflareEnv as unknown as Env;
