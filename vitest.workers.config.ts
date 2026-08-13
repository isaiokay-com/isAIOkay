import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const workersOptions = {
  main: "./test/worker/entry.ts",
  wrangler: { configPath: "./wrangler.jsonc" },
  miniflare: {
    bindings: {
      BETTER_AUTH_SECRET: "development-worker-auth-secret-at-least-32-characters",
      DELETED_IDENTITY_SECRET: "development-deleted-identity-secret-at-least-32-characters"
    }
  },
  additionalExports: { FeedbackAllowance: "DurableObject" as const }
};

export default defineConfig({
  plugins: [cloudflareTest(workersOptions)],
  test: {
    include: ["test/worker/**/*.test.ts"],
    pool: cloudflarePool(workersOptions),
    globals: true,
    restoreMocks: true
  }
});
