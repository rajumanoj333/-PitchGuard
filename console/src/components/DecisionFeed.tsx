type Decision = {
  id: string;
  severity: string;
  summary: string;
  ts?: { seconds: number } | null;
};

function fmt(ts?: { seconds: number } | null) {
  if (!ts) return "";
  return new Date(ts.seconds * 1000).toLocaleTimeString();
}

const sevDot: Record<string, string> = {
  info: "bg-accent/40",
  watch: "bg-accent",
  warn: "bg-warn",
  critical: "bg-crit",
};

export default function DecisionFeed({ decisions }: { decisions: Decision[] }) {
  if (!decisions.length) return <p className="text-gray-500">No decisions yet.</p>;
  return (
    <ul className="space-y-2">
      {decisions.map((d) => (
        <li key={d.id} className="flex gap-2 text-sm">
          <span className={`mt-1 w-2 h-2 rounded-full ${sevDot[d.severity] ?? "bg-gray-500"}`} />
          <div className="flex-1">
            <div className="text-gray-200">{d.summary}</div>
            <div className="text-xs text-gray-500">{fmt(d.ts)} · {d.severity}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
