const enabled = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

export const browserLaunchCommand = (platform: NodeJS.Platform, url: string): { command: string; args: string[] } => {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
};

/**
 * Conservatively detects whether launching a graphical browser is viable.
 * A failed launcher still falls back to headless mode at runtime.
 */
export const detectBrowserAvailability = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): boolean => {
  if (enabled(env.ISAI_OKAY_HEADLESS)) return false;
  if (enabled(env.ISAI_OKAY_BROWSER)) return true;
  if (enabled(env.CI)) return false;
  if (platform === "darwin" || platform === "win32") return true;
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET);
  }
  return false;
};
