import type { Env } from "../env";

export const isConfiguredAdministratorGitHubId = (env: Env, githubUserId: string): boolean =>
  (env.ADMIN_GITHUB_USER_IDS ?? "").split(",").some((value) => value.trim() === githubUserId);
