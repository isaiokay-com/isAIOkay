import { defineConfig, sessionDrivers } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://isaiokay.com",
  output: "server",
  adapter: cloudflare({
    // Astro's own sessions are unused: Better Auth stores auth sessions in D1.
    // This avoids the adapter provisioning a second KV namespace for sessions.
    imageService: "passthrough",
    configPath: process.env.WRANGLER_CONFIG_PATH ?? "./wrangler.jsonc"
  }),
  session: {
    driver: sessionDrivers.lruCache({})
  },
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()]
  }
});
