const DELETED_GITHUB_IDENTITY_DOMAIN = "deleted-github-identity:v1";
const encoder = new TextEncoder();

/**
 * One-way, secret-keyed marker used to prevent a deleted GitHub identity from
 * registering again and resetting its feedback allowance.
 */
export const getDeletedGitHubIdentityHash = async (secret: string, githubUserId: string): Promise<string> => {
  if (secret.length < 32) throw new Error("DELETED_IDENTITY_SECRET must contain at least 32 characters");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${DELETED_GITHUB_IDENTITY_DOMAIN}:${githubUserId}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
