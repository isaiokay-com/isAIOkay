import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicProfileRatingsPage, PublicProfileReport } from "../../db/repositories";

interface Props {
  initialReports: PublicProfileReport[];
  initialCursor: string | null;
  username: string;
  renderedAt: number;
}

const relativeDate = (submittedAt: number, renderedAt: number): string => {
  const days = Math.max(0, Math.floor((renderedAt - submittedAt) / 86_400_000));
  if (days === 0) return "Today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
};

const ratingAverage = (report: PublicProfileReport): number =>
  Math.round((report.resultQualityRating * 0.7 + report.usageEfficiencyRating * 0.3) * 10) / 10;

export default function ProfileRatingsList({ initialReports, initialCursor, username, renderedAt }: Props) {
  const [reports, setReports] = useState(initialReports);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`/api/profiles/${encodeURIComponent(username)}/ratings?cursor=${encodeURIComponent(cursor)}`, {
        headers: { accept: "application/json" }
      });
      if (!response.ok) throw new Error("ratings_request_failed");
      const page = await response.json() as PublicProfileRatingsPage;
      setReports((current) => [...current, ...page.reports]);
      setCursor(page.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [cursor, loading, username]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !cursor || error) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: "240px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, error, loadMore]);

  return (
    <>
      <div className="profile-report-list">
        {reports.map((report, index) => (
          <article key={`${report.submittedAt}-${report.modelSlug}-${index}`}>
            <div className="profile-report-model">
              <strong>{report.modelName}</strong>
              <span>{report.providerName}{report.agentName ? ` · via ${report.agentName}` : ""}</span>
            </div>
            <div className="profile-report-score"><strong>{ratingAverage(report)}</strong><span>overall</span></div>
            <dl className="profile-report-detail">
              <div><dt>Result</dt><dd>{report.resultQualityRating}/5</dd></div>
              <div><dt>Usage</dt><dd>{report.usageEfficiencyRating}/5</dd></div>
            </dl>
            <time dateTime={new Date(report.submittedAt).toISOString()}>{relativeDate(report.submittedAt, renderedAt)}</time>
          </article>
        ))}
      </div>
      {cursor && <div className="profile-ratings-loader" ref={sentinel}>
        <button className="button-light" type="button" onClick={() => void loadMore()} disabled={loading}>
          {loading ? "Loading ratings…" : error ? "Try loading again" : "Load more ratings"}
        </button>
        {error && <p role="status">Ratings could not load automatically.</p>}
      </div>}
    </>
  );
}
