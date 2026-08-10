import { z } from "zod";

/** Serialize JSON for an inline script without allowing an HTML end tag. */
export const serializeJsonForHtml = (value: unknown): string => (JSON.stringify(value) ?? "null")
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");

export const isSafeHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
};

export const httpsUrlSchema = z.url().refine(isSafeHttpsUrl, {
  message: "A credential-free HTTPS URL is required."
});

export const isXUsername = (value: string): boolean => /^[A-Za-z0-9_]{1,15}$/.test(value);

export const isGitHubUsername = (value: string): boolean =>
  /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/.test(value);

export const normalizeXUsername = (value: string): string => value.trim().replace(/^@/, "");
