import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const templatePath = new URL("../wrangler.example.jsonc", import.meta.url);
const outputPath = process.env.WRANGLER_CONFIG_OUTPUT
  ? process.env.WRANGLER_CONFIG_OUTPUT
  : fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));

const requiredIdentifier = (name, pattern) => {
  const value = process.env[name]?.trim();
  if (!value || !pattern.test(value))
    throw new Error(`${name} is missing or malformed.`);
  return value;
};

const databaseId = requiredIdentifier(
  "CLOUDFLARE_DATABASE_ID",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
);
const kvNamespaceId = requiredIdentifier(
  "CLOUDFLARE_KV_NAMESPACE_ID",
  /^[0-9a-f]{32}$/i,
);
const turnstileSiteKey = requiredIdentifier(
  "TURNSTILE_SITE_KEY",
  /^0x[A-Za-z0-9_-]{10,100}$/,
);
const postHogKey = process.env.POSTHOG_KEY?.trim();
if (postHogKey && !/^phc_[A-Za-z0-9_-]{10,}$/.test(postHogKey)) {
  throw new Error("POSTHOG_KEY is malformed.");
}
const postHogHost = postHogKey
  ? process.env.POSTHOG_HOST?.trim().replace(/\/$/, "") || "https://eu.i.posthog.com"
  : undefined;
if (postHogHost && !["https://eu.i.posthog.com", "https://us.i.posthog.com"].includes(postHogHost)) {
  throw new Error("POSTHOG_HOST must be a supported PostHog Cloud ingestion origin.");
}

let config = await readFile(templatePath, "utf8");

const replaceOnce = (needle, replacement) => {
  const first = config.indexOf(needle);
  if (first === -1 || config.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`Expected one production config placeholder: ${needle}`);
  }
  config = config.replace(needle, replacement);
};

replaceOnce(
  '  "compatibility_flags": ["nodejs_compat"],',
  '  "compatibility_flags": ["nodejs_compat"],\n  "routes": [{ "pattern": "isaiokay.com/*", "zone_name": "isaiokay.com" }],',
);
replaceOnce(
  '"database_id": "00000000-0000-0000-0000-000000000000"',
  `"database_id": "${databaseId}"`,
);
replaceOnce(
  '"id": "00000000000000000000000000000000"',
  `"id": "${kvNamespaceId}"`,
);
replaceOnce(
  '  "vars": {',
  '  "secrets": {\n    "required": [\n      "BETTER_AUTH_SECRET",\n      "GITHUB_CLIENT_ID",\n      "GITHUB_CLIENT_SECRET",\n      "TURNSTILE_SECRET_KEY",\n      "ADMIN_GITHUB_USER_IDS"\n    ]\n  },\n  "vars": {',
);
replaceOnce(
  '"BETTER_AUTH_URL": "http://localhost:8787"',
  '"BETTER_AUTH_URL": "https://isaiokay.com"',
);
replaceOnce(
  '"MOCK_GITHUB_AUTH": "true"',
  `"MOCK_GITHUB_AUTH": "false",\n    "TURNSTILE_SITE_KEY": "${turnstileSiteKey}"${postHogKey ? `,\n    "POSTHOG_KEY": "${postHogKey}",\n    "POSTHOG_HOST": "${postHogHost}"` : ""}`,
);

await writeFile(outputPath, config, { mode: 0o600 });
process.stdout.write(
  `Prepared production Wrangler configuration at ${outputPath}.\n`,
);
