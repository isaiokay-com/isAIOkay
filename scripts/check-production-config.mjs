import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "isaiokay-production-config-"));
const outputPath = join(directory, "wrangler.jsonc");
const turnstileSiteKey = "0x4AAAAAA_test_site_key";
const postHogKey = "phc_test_public_project_key";

try {
  const generateConfig = async (analytics) => {
    const result = spawnSync(process.execPath, ["scripts/prepare-cloudflare-config.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        WRANGLER_CONFIG_OUTPUT: outputPath,
        CLOUDFLARE_DATABASE_ID: "00000000-0000-4000-8000-000000000001",
        CLOUDFLARE_KV_NAMESPACE_ID: "00000000000000000000000000000001",
        TURNSTILE_SITE_KEY: turnstileSiteKey,
        POSTHOG_KEY: analytics ? postHogKey : "",
        POSTHOG_HOST: analytics ? "https://us.i.posthog.com" : "",
      },
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || "Production config generation failed.");
    }
    const source = await readFile(outputPath, "utf8");
    return JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
  };

  const config = await generateConfig(true);
  const requiredSecrets = new Set(config.secrets?.required ?? []);
  const variables = new Set(Object.keys(config.vars ?? {}));
  const duplicateBindings = [...requiredSecrets].filter((name) => variables.has(name));

  if (duplicateBindings.length > 0) {
    throw new Error(`Duplicate secret and variable bindings: ${duplicateBindings.join(", ")}`);
  }
  if (requiredSecrets.has("TURNSTILE_SITE_KEY")) {
    throw new Error("TURNSTILE_SITE_KEY must not be deployed as a secret.");
  }
  if (config.vars?.TURNSTILE_SITE_KEY !== turnstileSiteKey) {
    throw new Error("TURNSTILE_SITE_KEY was not injected into Worker vars.");
  }
  if (config.vars?.POSTHOG_KEY !== postHogKey || config.vars?.POSTHOG_HOST !== "https://us.i.posthog.com") {
    throw new Error("PostHog public configuration was not injected into Worker vars.");
  }

  const analyticsDisabledConfig = await generateConfig(false);
  if (analyticsDisabledConfig.vars?.POSTHOG_KEY !== undefined || analyticsDisabledConfig.vars?.POSTHOG_HOST !== undefined) {
    throw new Error("Optional PostHog configuration must remain absent when no project key is provided.");
  }

  process.stdout.write("Production Wrangler configuration check passed.\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
