const encoder = new TextEncoder();

export const sha256 = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

export const stableHash = async (secret: string, value: string): Promise<string> => sha256(`${secret}:${value}`);
