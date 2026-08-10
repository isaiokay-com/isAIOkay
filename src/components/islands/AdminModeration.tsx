import { useEffect, useMemo, useState } from "react";

interface Report {
  id: string;
  itemName: string;
  itemSlug: string;
  userId: string;
  resultQualityRating: number;
  usageEfficiencyRating: number;
  shortComment: string | null;
  tagsJson: string;
  moderationStatus: string;
  fraudRiskScore: number;
  submittedAt: number;
  source: "web" | "cli";
  tool: string | null;
  rawModelLabel: string | null;
  attribution: string | null;
}

interface TrackedItem {
  id: string;
  name: string;
  slug: string;
  providerName: string;
  type: "model" | "agent";
  description: string | null;
  officialUrl: string;
  pricingSummary: string | null;
  versionLabel: string | null;
  releaseAt: number | null;
  releaseSourceUrl: string | null;
  sortOrder: number;
}

interface CatalogCandidate {
  id: string;
  name: string;
  providerName: string;
  type: "model" | "agent";
  source: string;
  sourceUrl: string | null;
  rawLabel: string | null;
  seenCount: number;
  provenance: Array<{ source: string; url: string | null; seenAt: number; detail: string | null }>;
}

export default function AdminModeration({ initialReports, initialItems, initialCandidates }: { initialReports: Report[]; initialItems: TrackedItem[]; initialCandidates: CatalogCandidate[] }) {
  const [reports, setReports] = useState(initialReports);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState(initialItems[0]?.id ?? "");
  const selectedItem = useMemo(() => initialItems.find((item) => item.id === selectedItemId) ?? null, [initialItems, selectedItemId]);
  const [versionLabel, setVersionLabel] = useState("");
  const [releaseDate, setReleaseDate] = useState("");
  const [releaseSourceUrl, setReleaseSourceUrl] = useState("");
  const [releaseStatus, setReleaseStatus] = useState<string | null>(null);
  const [candidates, setCandidates] = useState(initialCandidates);
  const [candidateUrls, setCandidateUrls] = useState<Record<string, string>>({});
  const [catalogStatus, setCatalogStatus] = useState<string | null>(null);
  useEffect(() => {
    setVersionLabel(selectedItem?.versionLabel ?? "");
    setReleaseDate(selectedItem?.releaseAt ? new Date(selectedItem.releaseAt).toISOString().slice(0, 10) : "");
    setReleaseSourceUrl(selectedItem?.releaseSourceUrl ?? "");
  }, [selectedItem]);

  const saveRelease = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedItem) return;
    if (Boolean(releaseDate) !== Boolean(releaseSourceUrl)) {
      setReleaseStatus("Release date and source URL are required together.");
      return;
    }
    setReleaseStatus("Saving…");
    const response = await fetch("/api/admin/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: selectedItem.id,
        name: selectedItem.name,
        slug: selectedItem.slug,
        providerName: selectedItem.providerName,
        type: selectedItem.type,
        description: selectedItem.description ?? undefined,
        officialUrl: selectedItem.officialUrl,
        pricingSummary: selectedItem.pricingSummary ?? undefined,
        sortOrder: selectedItem.sortOrder,
        versionLabel: versionLabel || null,
        releaseAt: releaseDate ? new Date(`${releaseDate}T00:00:00Z`).getTime() : null,
        releaseSourceUrl: releaseSourceUrl || null
      })
    });
    setReleaseStatus(response.ok ? "Release reference saved. A qualifying baseline will be collected prospectively." : "Could not save the release reference.");
  };
  const changeStatus = async (reportId: string, status: "approved" | "excluded") => {
    setError(null);
    const previous = reports;
    setReports((current) => current.map((report) => report.id === reportId ? { ...report, moderationStatus: status } : report));
    const response = await fetch("/api/admin/reports", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reportId, status }) });
    if (!response.ok) {
      setReports(previous);
      setError("Could not update moderation. Refresh and try again.");
    }
  };
  const curateCandidate = async (candidateId: string, action: "promote" | "dismiss") => {
    const officialUrl = candidateUrls[candidateId]?.trim() ?? "";
    if (action === "promote" && !officialUrl) {
      setCatalogStatus("Enter and verify an official product URL before promotion.");
      return;
    }
    setCatalogStatus("Saving...");
    const response = await fetch("/api/admin/catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, candidateId, ...(action === "promote" ? { officialUrl } : {}) })
    });
    if (!response.ok) {
      setCatalogStatus("Could not update the catalog candidate.");
      return;
    }
    setCandidates((current) => current.filter((candidate) => candidate.id !== candidateId));
    setCatalogStatus(action === "promote" ? "Candidate promoted as a Pending catalog item." : "Candidate dismissed.");
  };
  return <div className="grid gap-8">
    <section aria-labelledby="release-baseline-heading" className="rounded-xl border border-[#e5e6e8] p-4">
      <h2 id="release-baseline-heading" className="m-0 text-lg font-extrabold tracking-[-.03em]">Release baseline references</h2>
      <p className="mt-1 text-sm text-[#59636e]">Record a documented release. The baseline is never locked unless the post-release window meets the configured evidence gates.</p>
      <form className="mt-4 grid gap-3 sm:grid-cols-4" onSubmit={(event) => void saveRelease(event)}>
        <label>Item<select value={selectedItemId} onChange={(event) => setSelectedItemId(event.currentTarget.value)}>{initialItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Version label<input value={versionLabel} maxLength={80} onChange={(event) => setVersionLabel(event.currentTarget.value)} placeholder="e.g. 5.2" /></label>
        <label>Release date<input type="date" value={releaseDate} onChange={(event) => setReleaseDate(event.currentTarget.value)} /></label>
        <label>Official release source<input type="url" value={releaseSourceUrl} onChange={(event) => setReleaseSourceUrl(event.currentTarget.value)} placeholder="https://…" /></label>
        <div className="sm:col-span-4 flex items-center gap-3"><button className="button-dark" type="submit">Save release reference</button><span role="status" aria-live="polite" className="text-sm text-[#59636e]">{releaseStatus}</span></div>
      </form>
    </section>
    <section aria-labelledby="catalog-candidates-heading" className="rounded-xl border border-[#e5e6e8] p-4">
      <h2 id="catalog-candidates-heading" className="m-0 text-lg font-extrabold tracking-[-.03em]">Catalog discovery queue</h2>
      <p className="mt-1 text-sm text-[#59636e]">Provider and social sources only nominate entries. Verify identity and an official URL before promotion; discovery frequency never affects scores.</p>
      <p role="status" aria-live="polite" className="text-sm text-[#59636e]">{catalogStatus}</p>
      {candidates.length === 0 ? <p className="text-sm text-[#59636e]">No pending candidates.</p> : <div className="overflow-x-auto border border-[#e5e6e8] rounded-xl"><table className="w-full min-w-[760px] border-collapse text-left text-sm"><thead className="bg-[#fafafa]"><tr><th className="p-3">Candidate</th><th className="p-3">Provenance</th><th className="p-3">Official URL</th><th className="p-3">Action</th></tr></thead><tbody>{candidates.map((candidate) => <tr key={candidate.id} className="border-t border-[#ececeb]"><td className="p-3"><b>{candidate.name}</b><div className="text-xs text-[#59636e]">{candidate.providerName} · {candidate.type} · seen {candidate.seenCount} times{candidate.rawLabel ? ` · ${candidate.rawLabel}` : ""}</div></td><td className="p-3"><div className="grid gap-1">{candidate.provenance.slice(-3).reverse().map((entry, index) => <span key={`${entry.seenAt}-${index}`} className="text-xs"><b>{entry.source.replaceAll("_", " ")}</b>{entry.url ? <> · <a className="text-[var(--accent)]" href={entry.url} rel="noreferrer" target="_blank">review source</a></> : ""}</span>)}</div></td><td className="p-3"><label className="sr-only" htmlFor={`official-${candidate.id}`}>Official URL for {candidate.name}</label><input id={`official-${candidate.id}`} type="url" value={candidateUrls[candidate.id] ?? ""} onChange={(event) => setCandidateUrls((current) => ({ ...current, [candidate.id]: event.currentTarget.value }))} placeholder="https://provider.example/model" /></td><td className="p-3"><div className="flex gap-2"><button className="button-dark !min-h-9 !px-3 !py-1" type="button" onClick={() => void curateCandidate(candidate.id, "promote")}>Promote</button><button className="button-light !min-h-9 !px-3 !py-1" type="button" onClick={() => void curateCandidate(candidate.id, "dismiss")}>Dismiss</button></div></td></tr>)}</tbody></table></div>}
    </section>
    <section aria-label="Feedback moderation">
    <p role="status" aria-live="polite" className="text-sm text-red-700">{error}</p>
    <div className="overflow-x-auto border border-[#e5e6e8] rounded-xl"><table className="w-full min-w-[860px] border-collapse text-left text-sm"><thead className="bg-[#fafafa]"><tr><th className="p-3">Item</th><th className="p-3">Source</th><th className="p-3">Experience</th><th className="p-3">Risk</th><th className="p-3">Comment</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead><tbody>{reports.map((report) => <tr key={report.id} className="border-t border-[#ececeb]"><td className="p-3 font-bold">{report.itemName}</td><td className="p-3"><span className="rounded-full bg-[#eef2f8] px-2 py-1 text-xs font-bold uppercase">{report.source}</span>{report.tool && <div className="mt-2 text-xs text-[#59636e]">{report.tool}{report.rawModelLabel ? ` · ${report.rawModelLabel}` : ""}<br />{report.attribution?.replaceAll("_", " ")}</div>}</td><td className="p-3">Result {report.resultQualityRating} · Usage {report.usageEfficiencyRating}</td><td className="p-3">{Math.round(report.fraudRiskScore * 100)}%</td><td className="max-w-xs p-3 text-[#59636e]">{report.shortComment ?? "None"}</td><td className="p-3 capitalize">{report.moderationStatus}</td><td className="p-3"><div className="flex gap-2"><button className="button-light !min-h-9 !px-3 !py-1" type="button" onClick={() => void changeStatus(report.id, "approved")}>Approve</button><button className="button-light !min-h-9 !px-3 !py-1" type="button" onClick={() => void changeStatus(report.id, "excluded")}>Exclude</button></div></td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
