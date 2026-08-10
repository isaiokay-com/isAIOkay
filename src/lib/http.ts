export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {})
    }
  });

export const toErrorResponse = (error: unknown): Response => {
  if (error instanceof HttpError) {
    return json(
      { error: { code: error.code, message: error.message, details: error.details } },
      { status: error.status }
    );
  }

  console.error("Unhandled application error", error);
  return json({ error: { code: "internal_error", message: "Something went wrong." } }, { status: 500 });
};

export const getClientKey = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

export const isLocalRequest = (request: Request): boolean => {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
};

export const isLocalDevelopmentRequest = (request: Request, canonicalUrl: string): boolean => {
  try {
    const hostname = new URL(canonicalUrl).hostname;
    const localCanonicalUrl = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
    return localCanonicalUrl && isLocalRequest(request);
  } catch {
    return false;
  }
};

export const getCookie = (request: Request, name: string): string | null => {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
};

export const appendSetCookie = (response: Response, value: string): Response => {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
