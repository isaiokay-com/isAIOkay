const required = (name, predicate, message) => {
  const value = process.env[name]?.trim() ?? "";
  if (!predicate(value)) throw new Error(`${name} ${message}. Production migration was not started.`);
};

required("BETTER_AUTH_SECRET", (value) => value.length >= 32, "must contain at least 32 characters");
required("DELETED_IDENTITY_SECRET", (value) => value.length >= 32, "must contain at least 32 characters and must not be rotated");
if (process.env.DELETED_IDENTITY_SECRET?.trim() === process.env.BETTER_AUTH_SECRET?.trim()) {
  throw new Error("DELETED_IDENTITY_SECRET must be generated independently from BETTER_AUTH_SECRET. Production migration was not started.");
}
required("GITHUB_CLIENT_ID", (value) => /^[A-Za-z0-9._-]{10,100}$/.test(value), "is missing or malformed");
required("GITHUB_CLIENT_SECRET", (value) => value.length >= 20 && value.length <= 200, "is missing or malformed");
required("TURNSTILE_SECRET_KEY", (value) => value.length >= 20, "is missing or malformed");
required("TURNSTILE_SITE_KEY", (value) => /^0x[A-Za-z0-9_-]{10,100}$/.test(value), "is missing or malformed");
required(
  "ADMIN_GITHUB_USER_IDS",
  (value) => value.split(",").every((id) => /^[1-9][0-9]*$/.test(id.trim())),
  "must be a comma-separated list of numeric GitHub user IDs"
);

process.stdout.write("Production GitHub authentication preflight passed.\n");
