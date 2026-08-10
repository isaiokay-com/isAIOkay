interface Props {
  selectedPeriod: "live" | "24h" | "7d";
  selectedSort: "recommended" | "result" | "usage" | "improving" | "degrading";
}

const sortOptions: Array<[Props["selectedSort"], string]> = [
  ["recommended", "Developer Signal"],
  ["result", "Result quality"],
  ["usage", "Usage efficiency"],
  ["improving", "Improving"],
  ["degrading", "Degrading"]
];

export default function RankingControls({ selectedPeriod, selectedSort }: Props) {
  return (
    <form action="/" method="get" className="ranking-toolbar" aria-label="Ranking filters">
      <strong className="toolbar-label">Coding models</strong>
      <div className="toolbar-controls">
        <div className="period-toggle" role="group" aria-label="Time period">
          {(["live", "24h", "7d"] as const).map((period) => <button key={period} className="pill pill--compact" data-active={selectedPeriod === period} type="submit" name="period" value={period}>{period === "live" ? "Live" : period === "24h" ? "24 hours" : "7 days"}</button>)}
        </div>
        <label className="sort-control">
          <span>Sort</span>
          <select name="sort" defaultValue={selectedSort} onChange={(event) => event.currentTarget.form?.requestSubmit()}>
            {sortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
      <input type="hidden" name="period" value={selectedPeriod} />
    </form>
  );
}
