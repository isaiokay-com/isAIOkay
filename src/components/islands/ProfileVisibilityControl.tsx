import { useRef, useState } from "react";
import { authClient } from "../../lib/auth-client";

interface Props {
  initialPublic: boolean;
  initialXUsername: string | null;
  username: string;
}

export default function ProfileVisibilityControl({ initialPublic, initialXUsername, username }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const xUsernameRef = useRef<HTMLInputElement>(null);
  const deletionConfirmationRef = useRef<HTMLInputElement>(null);
  const [isPublic, setIsPublic] = useState(initialPublic);
  const [xUsername, setXUsername] = useState(initialXUsername ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");

  const open = () => {
    setError(null);
    setDeleting(false);
    setDeletionConfirmation("");
    dialogRef.current?.showModal();
    requestAnimationFrame(() => xUsernameRef.current?.focus());
  };

  const beginDeletion = () => {
    setError(null);
    setDeleting(true);
    requestAnimationFrame(() => deletionConfirmationRef.current?.focus());
  };

  const cancelDeletion = () => {
    setError(null);
    setDeleting(false);
    setDeletionConfirmation("");
    requestAnimationFrame(() => xUsernameRef.current?.focus());
  };

  const deleteAccount = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/profile", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmation: deletionConfirmation })
      });
      const payload = await response.json() as { deleted?: boolean; error?: { message?: string } };
      if (!response.ok || !payload.deleted) throw new Error(payload.error?.message ?? "Your account could not be deleted.");
      await authClient.signOut().catch(() => undefined);
      window.location.assign("/?account=deleted");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Your account could not be deleted.");
      setPending(false);
    }
  };

  const close = () => {
    if (!pending) dialogRef.current?.close();
  };

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicProfileEnabled: isPublic, xUsername: xUsername.trim() || null })
      });
      const payload = await response.json() as { xUsername?: string | null; error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "Profile settings could not be saved.");
      setXUsername(payload.xUsername ?? "");
      dialogRef.current?.close();
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Profile settings could not be saved.");
      setPending(false);
    }
  };

  return (
    <div className="profile-owner-control">
      <button className="profile-edit-trigger" type="button" onClick={open} aria-label="Edit profile" title="Edit profile">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 20h4L18.5 9.5a2.12 2.12 0 0 0-3-3L5 17v3Z" />
          <path d="M14.5 8 16 6.5" />
        </svg>
        Edit profile
      </button>

      <dialog
        ref={dialogRef}
        className="profile-settings-dialog"
        aria-labelledby="profile-settings-title"
        aria-describedby="profile-settings-description"
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <form method="dialog" className="profile-settings-panel" onSubmit={(event) => event.preventDefault()}>
          <div className="profile-settings-heading">
            <div>
              <h2 id="profile-settings-title">{deleting ? "Delete account" : "Profile settings"}</h2>
              <p id="profile-settings-description">{deleting ? "Permanently remove your identity and access from IsAIokay.com." : "Choose what appears on your public developer profile."}</p>
            </div>
            <button className="profile-settings-close" type="button" onClick={close} disabled={pending} aria-label="Close profile settings">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>

          {deleting ? <div className="profile-delete-confirmation">
            <div className="profile-delete-warning">
              <strong>This cannot be undone.</strong>
              <p>Your public profile, GitHub identity, active sessions, and connected CLI installations will be removed. Optional notes, tags, and abuse-prevention identifiers will be erased.</p>
              <p>Minimal de-identified rating records remain for ranking integrity, including the rated model, optional coding agent, numeric scores, source, timestamps, and scoring or moderation fields.</p>
              <p>A secret-keyed, irreversible marker of your GitHub account remains so it cannot register again and reset voting limits.</p>
            </div>
            <label htmlFor="profile-delete-confirmation">Type <strong>{username}</strong> to confirm</label>
            <input
              ref={deletionConfirmationRef}
              id="profile-delete-confirmation"
              type="text"
              value={deletionConfirmation}
              onChange={(event) => setDeletionConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "profile-delete-error" : undefined}
            />
            {error && <p id="profile-delete-error" className="profile-settings-error" role="alert">{error}</p>}
          </div> : <div className="profile-settings-fields">
            <div className="profile-field">
              <label htmlFor="profile-x-username">X username <span>Optional</span></label>
              <div className="profile-x-input">
                <span aria-hidden="true">@</span>
                <input
                  ref={xUsernameRef}
                  id="profile-x-username"
                  type="text"
                  value={xUsername.replace(/^@/, "")}
                  onChange={(event) => setXUsername(event.target.value)}
                  placeholder="username"
                  autoComplete="off"
                  maxLength={15}
                  pattern="[A-Za-z0-9_]{1,15}"
                  aria-describedby={error ? "profile-settings-error" : "profile-x-helper"}
                  aria-invalid={Boolean(error)}
                  disabled={pending}
                />
              </div>
              {!error && <p id="profile-x-helper">This link is self-declared and is not verified by IsAIokay.com.</p>}
              {error && <p id="profile-settings-error" className="profile-settings-error" role="alert">{error}</p>}
            </div>

            <label className="profile-public-setting">
              <span>
                <strong>Public ratings</strong>
                <small>Show your structured model ratings. Trust and session data always stay private.</small>
              </span>
              <input type="checkbox" checked={isPublic} onChange={(event) => setIsPublic(event.target.checked)} disabled={pending} />
            </label>
            <section className="profile-danger-zone" aria-labelledby="profile-danger-title">
              <div><strong id="profile-danger-title">Delete account</strong><p>Remove your profile, identity, sessions, and CLI access.</p></div>
              <button type="button" onClick={beginDeletion} disabled={pending}>Delete account</button>
            </section>
          </div>}

          <div className="profile-settings-actions">
            {deleting ? <>
              <button className="button-light" type="button" onClick={cancelDeletion} disabled={pending}>Keep account</button>
              <button className="profile-delete-submit" type="button" onClick={() => void deleteAccount()} disabled={pending || deletionConfirmation !== username}>
                {pending ? "Deleting…" : "Delete my account"}
              </button>
            </> : <>
              <button className="button-light" type="button" onClick={close} disabled={pending}>Cancel</button>
              <button className="button-dark" type="button" onClick={() => void save()} disabled={pending}>
                {pending ? "Saving…" : "Save changes"}
              </button>
            </>}
          </div>
        </form>
      </dialog>
    </div>
  );
}
