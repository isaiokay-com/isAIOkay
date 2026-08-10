import { betterAuth } from "better-auth";
import type { Env } from "../env";
import { ensureProfile, getGithubAccountId, getProfile, type ProfileRecord } from "../db/repositories";
import { HttpError, getCookie, isLocalDevelopmentRequest } from "../lib/http";
import { isGitHubUsername, isSafeHttpsUrl } from "../lib/security";

export const DEVELOPMENT_USER_COOKIE = "is_ai_okay_dev_user";

interface GitHubUserResponse {
  id?: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
  created_at?: string;
}

export const getMinimalGitHubUserInfo = async (accessToken: string | undefined) => {
  if (!accessToken) return null;
  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "isaiokay.com",
        "x-github-api-version": "2022-11-28"
      },
      // Cloudflare Workers supports only "follow" and "manual". Manual keeps
      // unexpected redirects visible as non-OK responses instead of following.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    console.error("GitHub user info request failed before receiving a response", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Unknown fetch failure"
    });
    return null;
  }
  if (!response.ok) {
    console.error("GitHub user info request returned an error", {
      status: response.status,
      requestId: response.headers.get("x-github-request-id")
    });
    return null;
  }
  const profile = await response.json() as GitHubUserResponse;
  const githubUserId = typeof profile.id === "number" && Number.isSafeInteger(profile.id) && profile.id > 0
    ? String(profile.id)
    : null;
  const githubUsername = typeof profile.login === "string" && isGitHubUsername(profile.login) ? profile.login : null;
  const githubAccountCreatedAt = typeof profile.created_at === "string" ? Date.parse(profile.created_at) : Number.NaN;
  if (!githubUserId || !githubUsername || !Number.isFinite(githubAccountCreatedAt)) {
    console.error("GitHub user info response was missing required public identity fields", {
      hasStableId: Boolean(githubUserId),
      hasUsername: Boolean(githubUsername),
      hasAccountCreatedAt: Number.isFinite(githubAccountCreatedAt)
    });
    return null;
  }
  const name = typeof profile.name === "string" && profile.name.trim() ? profile.name.trim().slice(0, 100) : githubUsername;
  const image = typeof profile.avatar_url === "string" && isSafeHttpsUrl(profile.avatar_url) ? profile.avatar_url : undefined;
  return {
    user: {
      id: githubUserId,
      name,
      email: `github-${githubUserId}@isaiokay.invalid`,
      image,
      emailVerified: false,
      githubUsername,
      githubAccountCreatedAt
    },
    data: profile
  };
};

export const createAuth = (env: Env) => {
  const hasGitHubCredentials = Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  return betterAuth({
    appName: "IsAIokay.com",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [env.BETTER_AUTH_URL],
    useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
    defaultCookieAttributes: {
      httpOnly: true,
      secure: env.BETTER_AUTH_URL.startsWith("https://"),
      sameSite: "lax",
      path: "/"
    },
    ipAddress: { ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"] },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      cookiePrefix: "is-ai-okay"
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: false }
    },
    user: {
      additionalFields: {
        githubUsername: { type: "string", required: false },
        githubAccountCreatedAt: { type: "number", required: false }
      }
    },
    // GitHub owns identity fields. Profile preferences live in /api/profile.
    disabledPaths: ["/update-user"],
    socialProviders: hasGitHubCredentials ? {
      github: {
        clientId: env.GITHUB_CLIENT_ID!,
        clientSecret: env.GITHUB_CLIENT_SECRET!,
        // An empty scope grants public-profile access only. The custom mapper
        // performs exactly one /user request and never requests email or repos.
        disableDefaultScope: true,
        getUserInfo: (token) => getMinimalGitHubUserInfo(token.accessToken),
        overrideUserInfoOnSignIn: true
      }
    } : {}
  });
};

export type AuthInstance = ReturnType<typeof createAuth>;

export interface CurrentIdentity {
  userId: string;
  name: string;
  image: string | null;
  profile: ProfileRecord;
  isDevelopmentMock: boolean;
}

const getMockIdentity = async (request: Request, env: Env): Promise<CurrentIdentity | null> => {
  if (String(env.MOCK_GITHUB_AUTH) !== "true" || !isLocalDevelopmentRequest(request, env.BETTER_AUTH_URL)) return null;
  const userId = getCookie(request, DEVELOPMENT_USER_COOKIE);
  if (!userId) return null;
  const user = await env.DB.prepare("select id, name, image from user where id = ?").bind(userId).first<{ id: string; name: string; image: string | null }>();
  if (!user) return null;
  const profile = await getProfile(env, user.id);
  if (!profile) return null;
  return { userId: user.id, name: user.name, image: user.image, profile, isDevelopmentMock: true };
};

/** The only application gateway for reading Better Auth sessions. */
export const getCurrentIdentity = async (request: Request, env: Env): Promise<CurrentIdentity | null> => {
  const mock = await getMockIdentity(request, env);
  if (mock) return mock;

  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return null;
  const githubUserId = await getGithubAccountId(env, session.user.id);
  if (!githubUserId || !session.user.githubUsername || !session.user.githubAccountCreatedAt) {
    throw new HttpError(503, "github_identity_incomplete", "GitHub identity details could not be loaded. Please sign out and try again.");
  }
  const profile = await ensureProfile({
    env,
    userId: session.user.id,
    name: session.user.name,
    image: session.user.image,
    githubUserId,
    githubUsername: session.user.githubUsername,
    githubAccountCreatedAt: session.user.githubAccountCreatedAt
  });
  return { userId: session.user.id, name: session.user.name, image: session.user.image ?? null, profile, isDevelopmentMock: false };
};

export const requireIdentity = async (request: Request, env: Env): Promise<CurrentIdentity> => {
  const identity = await getCurrentIdentity(request, env);
  if (!identity) throw new HttpError(401, "authentication_required", "Sign in with GitHub to submit feedback.");
  if (identity.profile.status === "suspended" || identity.profile.status === "deleted") {
    throw new HttpError(403, "account_unavailable", "This account cannot submit feedback.");
  }
  return identity;
};

export const requireAdministrator = async (request: Request, env: Env): Promise<CurrentIdentity> => {
  const identity = await requireIdentity(request, env);
  const configuredIds = new Set((env.ADMIN_GITHUB_USER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  if (identity.profile.status !== "admin" && !configuredIds.has(identity.profile.githubUserId)) {
    throw new HttpError(403, "administrator_required", "Administrator access is required.");
  }
  return identity;
};

export const isDevelopmentMockEnabled = (request: Request, env: Env): boolean =>
  String(env.MOCK_GITHUB_AUTH) === "true" && isLocalDevelopmentRequest(request, env.BETTER_AUTH_URL);
