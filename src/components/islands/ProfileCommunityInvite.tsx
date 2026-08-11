import { useState } from "react";
import { authClient } from "../../lib/auth-client";

export default function ProfileCommunityInvite() {
  const [pending, setPending] = useState(false);

  const joinCommunity = async () => {
    setPending(true);
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: `${window.location.origin}/#ranking`
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="profile-community-invite" aria-labelledby="community-invite-title">
      <div className="profile-community-intro">
        <p className="profile-community-kicker"><span aria-hidden="true">+</span> Add your signal</p>
        <h2 id="community-invite-title">Your experience belongs in the ranking.</h2>
        <p>Join developers sharing recent, structured feedback on the AI coding models they actually use.</p>
        <div className="profile-community-actions">
          <button className="profile-community-primary" type="button" onClick={() => void joinCommunity()} disabled={pending}>
            {pending ? "Opening GitHub…" : "Join with GitHub"}
            {!pending && <span aria-hidden="true">→</span>}
          </button>
          <a href="/#ranking">Explore live rankings</a>
        </div>
      </div>

      <ol className="profile-community-points" aria-label="How contributing works">
        <li><span>01</span><p><strong>Rate what you use</strong>Share structured feedback from real coding sessions.</p></li>
        <li><span>02</span><p><strong>Strengthen the signal</strong>Help rankings reflect developer experience, not lab scores.</p></li>
        <li><span>03</span><p><strong>You control visibility</strong>Your developer profile stays private until you publish it.</p></li>
      </ol>
    </aside>
  );
}
