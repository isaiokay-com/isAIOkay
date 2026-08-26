import { useState } from "react";
import { authClient } from "../../lib/auth-client";

export default function ProfileCommunityInvite() {
  const [pending, setPending] = useState(false);

  const joinCommunity = async () => {
    setPending(true);
    try {
      await authClient.signIn.social({
        provider: "github",
        callbackURL: `${window.location.origin}/#subscriptions`
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <aside className="profile-community-invite" aria-labelledby="community-invite-title">
      <div className="profile-community-intro">
        <p className="profile-community-kicker"><span aria-hidden="true">+</span> Measure your plan</p>
        <h2 id="community-invite-title">Help reveal what coding subscriptions deliver.</h2>
        <p>Join developers contributing prompt-free token, model, effort, quota, and optional outcome data.</p>
        <div className="profile-community-actions">
          <button className="profile-community-primary" type="button" onClick={() => void joinCommunity()} disabled={pending}>
            {pending ? "Opening GitHub…" : "Join with GitHub"}
            {!pending && <span aria-hidden="true">→</span>}
          </button>
          <a href="/#subscriptions">Explore subscription rankings</a>
        </div>
      </div>

      <ol className="profile-community-points" aria-label="How contributing works">
        <li><span>01</span><p><strong>Connect subscriptions</strong>Tell the CLI which plan pays for each coding tool.</p></li>
        <li><span>02</span><p><strong>Measure real usage</strong>Contribute token and quota metadata without prompts or code.</p></li>
        <li><span>03</span><p><strong>Control aggregation</strong>Each subscription has its own explicit community-consent switch.</p></li>
      </ol>
    </aside>
  );
}
