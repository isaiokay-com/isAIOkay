# Better Auth and GitHub

Better Auth is the only authentication layer. The Worker builds an auth instance per request from the runtime `DB` D1 binding:

```ts
betterAuth({ database: env.DB, basePath: "/api/auth" })
```

This uses Better Auth’s native Cloudflare D1 support. Better Auth owns `user`, `account`, `session`, and `verification`; application trust and profile preferences live in `user_profile`.

## GitHub setup

Create a GitHub OAuth App and configure:

- local callback: `http://localhost:8787/api/auth/callback/github`;
- production callback: `https://isaiokay.com/api/auth/callback/github`;
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` as Worker secrets;
- `BETTER_AUTH_SECRET` as a random secret of at least 32 characters;
- `DELETED_IDENTITY_SECRET` as a separate random secret of at least 32 characters that is preserved permanently and never rotated;
- `BETTER_AUTH_URL=https://isaiokay.com` as the canonical production URL.

The provider disables Better Auth’s default `read:user` and `user:email` scopes. GitHub OAuth without requested scopes exposes only public profile information. A custom mapper makes exactly one `GET https://api.github.com/user` request during sign-in and never calls the email or repository APIs.

The stable numeric GitHub ID owns the account. The current GitHub login is the `/u/{username}` profile slug, while `created_at` is persisted for trust decisions. Missing or malformed required identity data fails sign-in safely; there is no scheduled metadata refresh.

An optional X username is editable in profile settings. It is self-declared outbound-link metadata only: it is not verified and never affects authentication, trust, administration, or profile ownership.

## Cookies and application access

The auth factory sets HTTP-only cookies, `SameSite=Lax`, path `/`, and secure cookies whenever `BETTER_AUTH_URL` is HTTPS. Trusted origins contain the canonical base URL. Use a canonical production domain rather than accepting arbitrary forwarded hosts.

Routes use `getCurrentIdentity`, `requireIdentity`, and `requireAdministrator`; components do not call Better Auth directly. Administrator permission is either `user_profile.status = admin` or an explicit stable-GitHub-ID allowlist in `ADMIN_GITHUB_USER_IDS`.
