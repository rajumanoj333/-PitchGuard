type Gate = {
  id: string;
  headcount: number;
  density: number;
  scan_rate_per_min: number;
};

export default function GateGrid({ gates }: { gates: Gate[] }) {
  if (!gates.length) return <p className="text-gray-500">No gate telemetry yet.</p>;
  const sorted = [...gates].sort((a, b) => a.id.localeCompare(b.id));
  return (
    <div className="grid grid-cols-4 gap-3">
      {sorted.map((g) => {
        const sev = g.density >= 4 ? "bg-crit" : g.density >= 3 ? "bg-warn" : "bg-accent/40";
        return (
          <div key={g.id} className={`rounded-lg p-3 ${sev} text-ink`}>
            <div className="text-xs uppercase opacity-75">Gate</div>
            <div className="text-2xl font-bold">{g.id}</div>
            <div className="mt-2 text-sm">{g.headcount} ppl</div>
            <div className="text-xs">{g.density.toFixed(2)}/m²</div>
            <div className="text-xs opacity-75">{g.scan_rate_per_min} scans/min</div>
          </div>
        );
      })}
    </div>
  );
}
