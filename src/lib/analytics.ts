export interface AnalyticsEvents {
  feedback_opened: { model: string };
  feedback_sign_in_started: { model: string | null };
  feedback_submitted: { model: string };
  feedback_edited: { model: string };
  cli_command_copied: { command: "install" | "onboarding" | "example_agent" | "headless_setup" | "install_all" | "preview" };
}

type AnalyticsCapture = <Name extends keyof AnalyticsEvents>(name: Name, properties: AnalyticsEvents[Name]) => void;

declare global {
  interface Window {
    isAIokayAnalytics?: { capture: AnalyticsCapture };
  }
}

/** Capture an explicitly approved product event when analytics is enabled. */
export const captureAnalytics = <Name extends keyof AnalyticsEvents>(name: Name, properties: AnalyticsEvents[Name]): void => {
  if (typeof window === "undefined") return;
  window.isAIokayAnalytics?.capture(name, properties);
};
