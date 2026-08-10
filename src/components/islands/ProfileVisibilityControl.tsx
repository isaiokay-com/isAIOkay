import { useRef, useState } from "react";

interface Props {
  initialPublic: boolean;
  initialXUsername: string | null;
}

export default function ProfileVisibilityControl({ initialPublic, initialXUsername }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const xUsernameRef = useRef<HTMLInputElement>(null);
  const [isPublic, setIsPublic] = useState(initialPublic);
  const [xUsername, setXUsername] = useState(initialXUsername ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setError(null);
    dialogRef.current?.showModal();
    requestAnimationFrame(() => xUsernameRef.current?.focus());
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
              <h2 id="profile-settings-title">Profile settings</h2>
              <p id="profile-settings-description">Choose what appears on your public developer profile.</p>
            </div>
            <button className="profile-settings-close" type="button" onClick={close} disabled={pending} aria-label="Close profile settings">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>

          <div className="profile-settings-fields">
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
          </div>

          <div className="profile-settings-actions">
            <button className="button-light" type="button" onClick={close} disabled={pending}>Cancel</button>
            <button className="button-dark" type="button" onClick={() => void save()} disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
