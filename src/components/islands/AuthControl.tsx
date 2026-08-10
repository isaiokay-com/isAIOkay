import { useState } from "react";
import { authClient } from "../../lib/auth-client";

interface Props {
  authenticated: boolean;
  name: string | null;
  image: string | null;
  username?: string | null;
}

export default function AuthControl({ authenticated, name, image, username }: Props) {
  const [pending, setPending] = useState(false);

  const signIn = async () => {
    setPending(true);
    try {
      await authClient.signIn.social({ provider: "github", callbackURL: window.location.href });
    } finally {
      setPending(false);
    }
  };

  const signOut = async () => {
    setPending(true);
    try {
      await authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign("/") } });
    } finally {
      setPending(false);
    }
  };

  if (authenticated) {
    return (
      <div className="account-actions">
        {username ? <a className="account-profile-link" href={`/u/${encodeURIComponent(username)}`}>
          {image ? <img src={image} alt="" referrerPolicy="no-referrer" /> : <span>{name?.slice(0, 1).toUpperCase()}</span>}
          <span className="hidden sm:inline">{name ?? `@${username}`}</span>
        </a> : <span className="account-profile-link">{name ?? "Account"}</span>}
        <button className="account-signout" type="button" onClick={() => void signOut()} disabled={pending}>{pending ? "Working" : "Sign out"}</button>
      </div>
    );
  }

  return <button className="button-dark !min-h-10 !rounded-full !py-2" type="button" onClick={() => void signIn()} disabled={pending}>{pending ? "Opening GitHub…" : "Sign in with GitHub"}</button>;
}
