import { useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "../../lib/auth-client";
import type { FeedbackAllowance } from "../../types";

interface ItemOption { id: string; slug: string; name: string; providerName: string; }
interface AgentOption { id: string; slug: string; name: string; providerName: string; }
interface FeedbackModalInfo { authenticated: boolean; siteKey: string | null; requiresTurnstile: boolean; }

interface Props { items: ItemOption[]; agents: AgentOption[]; initialSlug: string | null; }

const ratingDimensions = [
  { name: "resultQualityRating", label: "Result quality", hint: "How good was the result?" },
  { name: "usageEfficiencyRating", label: "Usage efficiency", hint: "Did the progress feel worth the usage?" }
] as const;

declare global {
  interface Window {
    turnstile?: { render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "error-callback": () => void }) => string; remove: (id: string) => void };
  }
}

const createIdempotencyKey = (): string => crypto.randomUUID();
const getStableDeviceId = (): string => {
  const key = "is-ai-okay:device-id:v1";
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
};

export default function FeedbackDialog({ items, agents, initialSlug }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(initialSlug);
  const [info, setInfo] = useState<FeedbackModalInfo | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ allowance: FeedbackAllowance } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedItem = useMemo(() => items.find((item) => item.slug === selectedSlug) ?? null, [items, selectedSlug]);

  const open = async (slug: string) => {
    setSelectedSlug(slug);
    setError(null);
    setNotice(null);
    setInfo(null);
    setToken(null);
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    const response = await fetch("/api/feedback", { credentials: "same-origin" });
    if (response.status === 401) {
      setInfo({ authenticated: false, siteKey: null, requiresTurnstile: false });
      return;
    }
    if (!response.ok) {
      setError("Feedback is temporarily unavailable.");
      return;
    }
    setInfo(await response.json() as FeedbackModalInfo);
  };

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>("[data-feedback-item]");
      if (!target) return;
      event.preventDefault();
      const slug = target.dataset.feedbackItem;
      if (slug) void open(slug);
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  });

  useEffect(() => {
    if (initialSlug) void open(initialSlug);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4_500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!info?.requiresTurnstile || !info.siteKey || !turnstileRef.current || !info.authenticated) return;
    const render = () => {
      if (!turnstileRef.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(turnstileRef.current, {
        sitekey: info.siteKey!, callback: setToken, "error-callback": () => setError("Verification could not be loaded.")
      });
    };
    if (window.turnstile) {
      render();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.onload = render;
    (document.head as unknown as HTMLElement).appendChild(script as unknown as Node);
    return () => {
      if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [info]);

  const signIn = async () => {
    await authClient.signIn.social({ provider: "github", callbackURL: `${window.location.pathname}?feedback=${encodeURIComponent(selectedSlug ?? "")}` });
  };

  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedItem) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          trackedItemId: selectedItem.id,
          agentItemId: form.get("agentItemId") || null,
          resultQualityRating: Number(form.get("resultQualityRating")),
          usageEfficiencyRating: Number(form.get("usageEfficiencyRating")),
          tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
          shortComment: String(form.get("shortComment") ?? "").trim() || undefined,
          turnstileToken: token ?? undefined,
          deviceId: getStableDeviceId(),
          idempotencyKey: createIdempotencyKey()
        })
      });
      const body = await response.json() as { allowance?: FeedbackAllowance; error?: { message?: string } };
      if (!response.ok || !body.allowance) {
        setError(body.error?.message ?? "Your feedback could not be saved.");
        return;
      }
      formElement.reset();
      setToken(null);
      setInfo(null);
      dialogRef.current?.close();
      setNotice({ allowance: body.allowance });
    } catch {
      setError("Your feedback could not be saved. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return <>
    <dialog
      ref={dialogRef}
      className="feedback-dialog"
      aria-labelledby="feedback-title"
      onClose={() => setSelectedSlug(null)}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <form method="dialog" className="feedback-dialog-header">
        <strong id="feedback-title">Rate {selectedItem?.name ?? "this model"}</strong>
        <button className="button-light feedback-dialog-close" aria-label="Close feedback dialog">Close</button>
      </form>
      {info?.authenticated === false ? (
        <div className="p-5">
          <p className="feedback-signin-copy">Feedback is tied to a GitHub identity to keep the signal useful.</p>
          <button className="button-dark mt-4" type="button" onClick={() => void signIn()}>Sign in with GitHub</button>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <fieldset disabled={submitting}>
            <legend className="visually-hidden">Your recent experience</legend>
            <div className="grid gap-3">
              <fieldset className="feedback-ratings" aria-describedby="feedback-rating-help">
                <legend>Two quick questions</legend>
                <p id="feedback-rating-help">Three means okay or about what you expected.</p>
                <div className="feedback-rating-list">
                  {ratingDimensions.map((dimension) => (
                    <fieldset className="feedback-rating-row" key={dimension.name}>
                      <legend><strong>{dimension.label}</strong><span>{dimension.hint}</span></legend>
                      <div className="feedback-rating-options">
                        {[1, 2, 3, 4, 5].map((rating) => (
                          <label key={rating}>
                            <input
                              type="radio"
                              name={dimension.name}
                              value={rating}
                              defaultChecked={rating === 3}
                              autoFocus={dimension.name === "resultQualityRating" && rating === 3}
                              aria-label={`${dimension.label}: ${rating} out of 5`}
                            />
                            <span>{rating}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </div>
              </fieldset>
              <details className="feedback-context">
                <summary><span>Add context</span><small>Optional</small></summary>
                <div className="grid gap-3">
                  <label>Coding agent used<select name="agentItemId" defaultValue=""><option value="">Direct API, playground, or not sure</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select><span className="form-helper">Stored as context; only the model affects the ranking.</span></label>
                  <label>Tags (optional)<input name="tags" maxLength={190} placeholder="fast, tool-use, regressions" /></label>
                  <label>Short note (optional)<textarea name="shortComment" maxLength={500} rows={3} /></label>
                </div>
              </details>
              {info?.requiresTurnstile && <div ref={turnstileRef} aria-label="Human verification" />}
            </div>
          </fieldset>
          <p role="status" aria-live="polite" className="feedback-error">{error ?? ""}</p>
          <div className="dialog-actions"><button className="button-dark" type="submit" disabled={submitting}>{submitting ? "Saving…" : "Save rating"}</button></div>
        </form>
      )}
    </dialog>
    {notice && (
      <div className="feedback-toast" role="status" aria-live="polite" aria-atomic="true">
        <span aria-hidden="true">✓</span>
        <div><strong>Rating saved</strong><small>{notice.allowance.remaining} remaining today</small></div>
      </div>
    )}
  </>;
}
