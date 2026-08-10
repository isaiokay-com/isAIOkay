import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "isaiokay-production-config-"));
const outputPath = join(directory, "wrangler.jsonc");
const turnstileSiteKey = "0x4AAAAAA_test_site_key";

try {
  const result = spawnSync(process.execPath, ["scripts/prepare-cloudflare-config.mjs"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_CONFIG_OUTPUT: outputPath,
      CLOUDFLARE_DATABASE_ID: "00000000-0000-4000-8000-000000000001",
      CLOUDFLARE_KV_NAMESPACE_ID: "00000000000000000000000000000001",
      TURNSTILE_SITE_KEY: turnstileSiteKey,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Production config generation failed.");
  }

  const source = await readFile(outputPath, "utf8");
  const config = JSON.parse(source.replace(/^\s*\/\/.*$/gm, ""));
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

  process.stdout.write("Production Wrangler configuration check passed.\n");
} finally {
  await rm(directory, { recursive: true, force: true });
}
