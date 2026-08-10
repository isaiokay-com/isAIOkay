import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type OneShotRunner = "npx" | "pnpm dlx" | "bunx";

/**
 * One-shot package runners expose the CLI only inside a temporary PATH entry.
 * Provider hooks run later, outside that environment, so they must never be
 * configured to call the transient executable.
 */
export const detectOneShotRunner = (env: NodeJS.ProcessEnv = process.env): OneShotRunner | null => {
  if (env.npm_lifecycle_event === "npx") return "npx";
  if (env.npm_lifecycle_event === "bunx") return "bunx";

  const userAgent = env.npm_config_user_agent ?? "";
  const path = env.PATH ?? "";
  if (userAgent.startsWith("pnpm/") && /(?:^|[\\/])pnpm[\\/]dlx[\\/]/.test(path)) return "pnpm dlx";
  return null;
};

export const executableExists = async (
  command: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): Promise<boolean> => {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = env.PATH;
  if (!path) return false;
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const rawDirectory of path.split(delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      try {
        await access(join(directory, `${command}${extension}`), platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        // Continue through PATH without exposing or retaining its contents.
      }
    }
  }
  return false;
};
