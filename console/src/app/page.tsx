"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Decision = {
  id: string;
  severity: "info" | "watch" | "warn" | "critical";
  summary: string;
  actions?: string[];
  affected_zones?: string[];
  reroute_from_zone?: string | null;
  reroute_to_zone?: string | null;
  reroute_to_gate?: string | null;
  alarm?: boolean;
  ts?: { seconds: number; nanoseconds?: number } | null;
};
type Zone = {
  id: string;
  headcount: number;
  density: number;
  lat?: number;
  lng?: number;
};
type Fan = {
  id: string;
  name: string;
  zone: ZoneId;
  lat: number;
  lng: number;
  accuracy?: number;
  ts?: { seconds: number } | null;
};
type AlertDoc = {
  id: string;
  zone_id: string;
  exit_gate: string;
  message: string;
  operator?: string;
  ts?: { seconds: number } | null;
};
type ZoneId = "NORTH" | "EAST" | "SOUTH" | "WEST";

const BRAIN = process.env.NEXT_PUBLIC_BRAIN_URL || "";
const STADIUM_CAPACITY = 132_000;
const DENSITY_LIMIT = 4.0;

const PLACES: Record<ZoneId, { gate: string; lat: number; lng: number; nice: string; arrow: string; color: string }> = {
  NORTH: { gate: "Gate 1",  lat: 23.09365, lng: 72.59710, nice: "North Side", arrow: "↑", color: "#3b82f6" },
  EAST:  { gate: "Gate 5",  lat: 23.09225, lng: 72.59870, nice: "East Side",  arrow: "→", color: "#10b981" },
  SOUTH: { gate: "Gate 9",  lat: 23.09075, lng: 72.59720, nice: "South Side", arrow: "↓", color: "#f59e0b" },
  WEST:  { gate: "Gate 11", lat: 23.09225, lng: 72.59570, nice: "West Side",  arrow: "←", color: "#a855f7" },
};

function crowdState(density: number): { word: string; color: string } {
  if (density >= 4) return { word: "Too many", color: "#ef4444" };
  if (density >= 3) return { word: "Crowded",  color: "#f59e0b" };
  if (density >= 1.5) return { word: "Busy",   color: "#22d3ee" };
  return { word: "Calm", color: "#22c55e" };
}

function relTime(seconds?: number, now: number = Date.now()) {
  if (!seconds) return "—";
  const diff = Math.max(0, Math.floor(now / 1000 - seconds));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function initials(name: string) {
  return (name || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("") || "?";
}

export default function Page() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [fans, setFans] = useState<Fan[]>([]);
  const [alerts, setAlerts] = useState<AlertDoc[]>([]);
  const [showMove, setShowMove] = useState(false);
  const [sendingQuick, setSendingQuick] = useState(false);
  const [quickErr, setQuickErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<ZoneId | "ALL">("ALL");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, "decisions"), orderBy("ts", "desc"), limit(8)),
      (snap) => setDecisions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Decision, "id">) }))),
    );
    const u2 = onSnapshot(collection(db, "zones"), (snap) =>
      setZones(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Zone, "id">) }))),
    );
    const u3 = onSnapshot(collection(db, "fans"), (snap) =>
      setFans(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Fan, "id">) }))),
    );
    const u4 = onSnapshot(
      query(collection(db, "alerts"), orderBy("ts", "desc"), limit(8)),
      (snap) => setAlerts(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AlertDoc, "id">) }))),
    );
    const interval = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => { u1(); u2(); u3(); u4(); clearInterval(interval); };
  }, []);

  const latest = decisions[0];
  const fansByZone = useMemo(() => {
    const m: Record<string, number> = { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 };
    for (const f of fans) m[f.zone] = (m[f.zone] || 0) + 1;
    return m;
  }, [fans]);

  const filteredFans = useMemo(() => {
    const list = filter === "ALL" ? fans : fans.filter((f) => f.zone === filter);
    return list.slice().sort((a, b) => (b.ts?.seconds || 0) - (a.ts?.seconds || 0));
  }, [fans, filter]);

  const totalPeople = useMemo(() => zones.reduce((s, z) => s + (z.headcount || 0), 0), [zones]);
  const occupancyPct = Math.min(100, (totalPeople / STADIUM_CAPACITY) * 100);

  const worstZone = useMemo<ZoneId>(() => {
    if (!zones.length) return "NORTH";
    const sorted = zones.slice().sort((a, b) => (b.density || 0) - (a.density || 0));
    return (sorted[0]?.id as ZoneId) || "NORTH";
  }, [zones]);
  const safestZone = useMemo<ZoneId>(() => {
    if (!zones.length) return "SOUTH";
    const sorted = zones.slice().sort((a, b) => (a.density || 0) - (b.density || 0));
    return (sorted[0]?.id as ZoneId) || "SOUTH";
  }, [zones]);
  const peakDensity = useMemo(() => {
    if (!zones.length) return 0;
    return Math.max(...zones.map((z) => z.density || 0));
  }, [zones]);

  const recommend =
    latest &&
    (latest.severity === "warn" || latest.severity === "critical") &&
    latest.reroute_from_zone &&
    latest.reroute_to_zone
      ? {
          from: latest.reroute_from_zone as ZoneId,
          to: latest.reroute_to_zone as ZoneId,
          gate: latest.reroute_to_gate || PLACES[latest.reroute_to_zone as ZoneId]?.gate,
          summary: latest.summary,
          actions: latest.actions || [],
          severity: latest.severity,
        }
      : null;

  async function sendQuickReroute() {
    if (!recommend) return;
    if (!BRAIN) { setQuickErr("Brain URL not set"); return; }
    setSendingQuick(true); setQuickErr(null);
    try {
      const target = PLACES[recommend.to];
      const res = await fetch(`${BRAIN}/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          zone_id: recommend.from,
          exit_gate: target.gate,
          exit_lat: target.lat,
          exit_lng: target.lng,
          message: `Walk to ${target.gate} on the ${PLACES[recommend.to].nice}. Stay calm and follow the arrow on your phone.`,
          severity: "critical",
          operator: "control-room-quick",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e: any) {
      setQuickErr(e?.message || "Failed");
    } finally {
      setSendingQuick(false);
    }
  }

  const status = !latest
    ? { word: "All quiet", color: "#22c55e" }
    : latest.severity === "critical"
    ? { word: "Move people now", color: "#ef4444" }
    : latest.severity === "warn"
    ? { word: "Crowd building", color: "#f59e0b" }
    : latest.severity === "watch"
    ? { word: "Watching", color: "#22d3ee" }
    : { word: "All quiet", color: "#22c55e" };

  void tick;
  const now = Date.now();

  return (
    <main className="min-h-[100dvh] bg-ink text-white">
      <div className="max-w-[1320px] mx-auto px-5 sm:px-8 py-6 flex flex-col gap-5">
        {/* Header */}
        <header className="flex items-center justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">PitchGuard · Narendra Modi Stadium</div>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-1">Control Room</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <a
              href="/fan"
              className="hidden sm:inline-flex items-center gap-2 px-4 py-3 rounded-xl border border-line text-white/80 hover:text-white hover:border-white/40 transition-colors text-sm"
            >
              Fan view <span className="text-white/45">›</span>
            </a>
            <button
              onClick={() => setShowMove(true)}
              className="px-5 py-3 rounded-xl text-white font-semibold text-sm sm:text-base active:scale-[0.98] transition-transform shadow-lg shadow-red-900/40"
              style={{ background: "#ef4444" }}
            >
              Move people
            </button>
          </div>
        </header>

        {/* KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Kpi label="Right now" value={status.word} color={status.color} pulse />
          <Kpi label="People in stadium" value={totalPeople.toLocaleString()} sub={`${occupancyPct.toFixed(0)}% of capacity`} />
          <Kpi
            label="Peak density"
            value={`${peakDensity.toFixed(2)}/m²`}
            sub={`limit ${DENSITY_LIMIT.toFixed(1)}/m²`}
            color={peakDensity >= DENSITY_LIMIT ? "#ef4444" : peakDensity >= 3 ? "#f59e0b" : undefined}
          />
          <Kpi label="Phones connected" value={fans.length.toLocaleString()} sub={fans.length === 0 ? "no fan app open" : "live"} />
        </div>

        {/* Recommended action */}
        {recommend ? (
          <section
            className="rounded-2xl p-5 sm:p-6 border flex flex-col gap-4"
            style={{ background: `linear-gradient(135deg, ${status.color}1a, transparent 60%)`, borderColor: `${status.color}55` }}
          >
            <div className="flex items-start gap-4">
              <span className="w-3 h-3 mt-2 rounded-full live-dot shrink-0" style={{ background: status.color, boxShadow: `0 0 24px ${status.color}` }} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] uppercase tracking-[0.22em] text-white/55">Recommended action</div>
                <div className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight">
                  Move people from{" "}
                  <span style={{ color: PLACES[recommend.from].color }}>{PLACES[recommend.from].nice}</span>{" → "}
                  <span style={{ color: PLACES[recommend.to].color }}>{recommend.gate}</span>
                </div>
                <p className="text-sm sm:text-base text-white/75 mt-2 max-w-3xl leading-snug">{recommend.summary}</p>
              </div>
              <button
                onClick={sendQuickReroute}
                disabled={sendingQuick}
                className="hidden sm:inline-flex items-center px-5 py-3 rounded-xl bg-white text-black font-semibold text-sm active:scale-[0.98] transition-transform disabled:opacity-50"
              >
                {sendingQuick ? "Sending…" : "Send to phones"}
              </button>
            </div>
            {recommend.actions.length > 0 && (
              <ul className="grid sm:grid-cols-2 gap-2 text-sm text-white/85">
                {recommend.actions.slice(0, 4).map((a, i) => (
                  <li key={i} className="flex gap-2.5"><span className="text-white/40 mt-0.5">{i + 1}</span><span>{a}</span></li>
                ))}
              </ul>
            )}
            {quickErr && (
              <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5">{quickErr}</div>
            )}
            <button
              onClick={sendQuickReroute}
              disabled={sendingQuick}
              className="sm:hidden w-full py-3 rounded-xl bg-white text-black font-semibold active:scale-[0.98] disabled:opacity-50"
            >
              {sendingQuick ? "Sending…" : "Send to phones"}
            </button>
          </section>
        ) : (
          <section
            className="rounded-2xl p-5 sm:p-6 border flex items-center gap-4"
            style={{ background: `linear-gradient(135deg, ${status.color}12, transparent 60%)`, borderColor: `${status.color}40` }}
          >
            <span className="w-3 h-3 rounded-full live-dot shrink-0" style={{ background: status.color, boxShadow: `0 0 24px ${status.color}` }} />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] uppercase tracking-[0.22em] text-white/55">Right now</div>
              <div className="mt-1 text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: status.color }}>{status.word}</div>
              {latest?.summary && <p className="text-sm text-white/65 mt-2 max-w-3xl leading-snug">{latest.summary}</p>}
            </div>
          </section>
        )}

        {/* Main: live attendees (replaces map) + right column */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Live attendees */}
          <section className="lg:col-span-2 bg-panel border border-line rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div>
                <div className="text-[11px] uppercase tracking-[0.22em] text-white/55">Live attendees</div>
                <div className="text-sm text-white/75 mt-1">Every connected phone, name and seat</div>
              </div>
              <div className="flex items-center gap-1.5">
                <FilterChip active={filter === "ALL"} onClick={() => setFilter("ALL")} label={`All · ${fans.length}`} color="#a78bfa" />
                {(Object.keys(PLACES) as ZoneId[]).map((z) => (
                  <FilterChip key={z} active={filter === z} onClick={() => setFilter(z)} label={`${PLACES[z].arrow} ${fansByZone[z]}`} color={PLACES[z].color} />
                ))}
              </div>
            </div>

            {filteredFans.length === 0 ? (
              <div className="py-12 text-center">
                <div className="text-4xl mb-3">📱</div>
                <div className="text-base font-semibold text-white/85">No phones connected</div>
                <p className="text-sm text-white/55 mt-2 max-w-sm mx-auto">
                  Have a fan open{" "}
                  <code className="px-1.5 py-0.5 rounded bg-ink border border-line text-white/80">pitchguard.web.app/fan</code>{" "}
                  on their phone and pick a seating side.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full min-w-[640px]">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-[0.16em] text-white/45">
                      <th className="text-left font-medium px-2 py-2">Fan</th>
                      <th className="text-left font-medium px-2 py-2">Seat side</th>
                      <th className="text-left font-medium px-2 py-2">Location (lat, lng)</th>
                      <th className="text-right font-medium px-2 py-2">Accuracy</th>
                      <th className="text-right font-medium px-2 py-2">Last seen</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm">
                    {filteredFans.map((f) => {
                      const p = PLACES[f.zone];
                      const fresh = (now / 1000 - (f.ts?.seconds || 0)) < 15;
                      return (
                        <tr key={f.id} className="border-t border-line hover:bg-white/[0.025]">
                          <td className="px-2 py-3 align-middle">
                            <div className="flex items-center gap-3">
                              <span
                                className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
                                style={{ background: `${p?.color || "#a78bfa"}33`, color: p?.color || "#a78bfa", border: `1px solid ${p?.color || "#a78bfa"}55` }}
                              >
                                {initials(f.name)}
                              </span>
                              <div className="min-w-0">
                                <div className="font-semibold truncate flex items-center gap-2">
                                  {f.name || "Fan"}
                                  {fresh && <span className="w-1.5 h-1.5 rounded-full bg-green-400 live-dot" title="Active" />}
                                </div>
                                <div className="text-[11px] text-white/40 truncate">{f.id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-2 py-3 align-middle">
                            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium" style={{ background: `${p?.color || "#666"}22`, color: p?.color || "#aaa" }}>
                              <span>{p?.arrow}</span>{p?.nice || f.zone}
                            </span>
                            <div className="text-[11px] text-white/40 mt-1">{p?.gate}</div>
                          </td>
                          <td className="px-2 py-3 align-middle">
                            <a
                              href={`https://www.google.com/maps/search/?api=1&query=${f.lat},${f.lng}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs num text-white/80 hover:text-accent underline decoration-white/15 underline-offset-2"
                            >
                              {f.lat?.toFixed(5)}, {f.lng?.toFixed(5)}
                            </a>
                          </td>
                          <td className="px-2 py-3 align-middle text-right num text-xs text-white/65">
                            ±{Math.round(f.accuracy || 0)} m
                          </td>
                          <td className="px-2 py-3 align-middle text-right text-xs num" style={{ color: fresh ? "#22c55e" : "#a1a1aa" }}>
                            {relTime(f.ts?.seconds, now)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Right column: density bars + activity feed */}
          <section className="space-y-4">
            <div className="bg-panel border border-line rounded-2xl p-5">
              <div className="text-[11px] uppercase tracking-[0.22em] text-white/55">Crowd by side</div>
              <div className="text-xs text-white/55 mt-0.5 mb-3">Density vs {DENSITY_LIMIT.toFixed(1)}/m² limit</div>
              <div className="space-y-3">
                {(Object.keys(PLACES) as ZoneId[]).map((zid) => {
                  const z = zones.find((x) => x.id === zid);
                  const density = z?.density ?? 0;
                  const head = z?.headcount ?? 0;
                  const s = crowdState(density);
                  const pct = Math.min(100, (density / DENSITY_LIMIT) * 100);
                  return (
                    <div key={zid}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-base" style={{ color: PLACES[zid].color }}>{PLACES[zid].arrow}</span>
                        <span className="text-sm font-semibold flex-1 truncate">{PLACES[zid].nice}</span>
                        <span className="text-xs text-white/45 num">📱 {fansByZone[zid]}</span>
                      </div>
                      <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500 ease-out"
                          style={{ width: `${pct}%`, background: s.color, boxShadow: `0 0 12px ${s.color}88` }}
                        />
                      </div>
                      <div className="flex justify-between text-[11px] text-white/45 mt-1 num">
                        <span style={{ color: s.color }}>{s.word}</span>
                        <span>{density.toFixed(2)}/m² · {head.toLocaleString()}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-panel border border-line rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.22em] text-white/55">Activity</div>
                  <div className="text-xs text-white/55 mt-0.5">Decisions and alerts</div>
                </div>
                <div className="text-[10px] text-white/45">last 8</div>
              </div>
              <ul className="space-y-2.5 max-h-[260px] overflow-y-auto pr-1">
                {alerts.length === 0 && decisions.length === 0 && (
                  <li className="text-sm text-white/40">No activity yet.</li>
                )}
                {alerts.map((a) => (
                  <li key={`a-${a.id}`} className="flex gap-2.5">
                    <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] uppercase tracking-wider text-red-300/85">Alert sent</div>
                      <div className="text-xs text-white/85 leading-snug">
                        <strong style={{ color: PLACES[a.zone_id as ZoneId]?.color }}>{PLACES[a.zone_id as ZoneId]?.nice || a.zone_id}</strong>
                        {" → "}<strong>{a.exit_gate}</strong>
                      </div>
                      <div className="text-[10px] text-white/40 mt-0.5">{relTime(a.ts?.seconds, now)}</div>
                    </div>
                  </li>
                ))}
                {decisions.map((d) => {
                  const sev = d.severity;
                  const dot = sev === "critical" ? "#ef4444" : sev === "warn" ? "#f59e0b" : sev === "watch" ? "#22d3ee" : "#22c55e";
                  return (
                    <li key={`d-${d.id}`} className="flex gap-2.5">
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-wider" style={{ color: dot }}>{sev}</div>
                        <div className="text-xs text-white/85 leading-snug">{d.summary || "—"}</div>
                        <div className="text-[10px] text-white/40 mt-0.5">{relTime(d.ts?.seconds, now)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        </div>
      </div>

      {showMove && (
        <MovePeopleModal
          worstZone={worstZone}
          safestZone={safestZone}
          fansByZone={fansByZone}
          onClose={() => setShowMove(false)}
        />
      )}
    </main>
  );
}

function Kpi({ label, value, sub, color, pulse }: { label: string; value: string; sub?: string; color?: string; pulse?: boolean }) {
  return (
    <div className="bg-panel border border-line rounded-2xl px-4 py-3.5">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-white/45">
        {pulse && color && <span className="w-1.5 h-1.5 rounded-full live-dot" style={{ background: color }} />}
        <span>{label}</span>
      </div>
      <div className="text-xl sm:text-2xl font-semibold tracking-tight num mt-1" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[11px] text-white/45 mt-0.5">{sub}</div>}
    </div>
  );
}

function FilterChip({ active, onClick, label, color }: { active: boolean; onClick: () => void; label: string; color: string }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] px-2.5 py-1.5 rounded-full border transition-colors ${active ? "text-white" : "text-white/70 hover:text-white"}`}
      style={{
        background: active ? `${color}33` : "transparent",
        borderColor: active ? color : "#262932",
      }}
    >
      {label}
    </button>
  );
}

function MovePeopleModal({
  worstZone,
  safestZone,
  fansByZone,
  onClose,
}: {
  worstZone: ZoneId;
  safestZone: ZoneId;
  fansByZone: Record<string, number>;
  onClose: () => void;
}) {
  const [from, setFrom] = useState<ZoneId>(worstZone);
  const [to, setTo] = useState<ZoneId>(safestZone);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send() {
    if (!BRAIN) { setErr("Brain URL not set"); return; }
    if (from === to) { setErr("Pick a different destination"); return; }
    setSending(true); setErr(null);
    try {
      const target = PLACES[to];
      const res = await fetch(`${BRAIN}/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          zone_id: from,
          exit_gate: target.gate,
          exit_lat: target.lat,
          exit_lng: target.lng,
          message: `Walk to ${target.gate} on the ${PLACES[to].nice}. Stay calm and follow the arrow on your phone.`,
          severity: "critical",
          operator: "control-room",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onClose();
    } catch (e: any) {
      setErr(e?.message || "Failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-panel rounded-3xl border border-line max-w-md w-full p-6 sm:p-7 space-y-6">
        <div>
          <div className="text-[11px] uppercase tracking-[0.22em] text-white/45">Action</div>
          <h2 className="text-2xl font-semibold tracking-tight mt-1">Move people</h2>
          <p className="text-sm text-white/60 mt-1">Phones in the chosen side will buzz and see a walking arrow.</p>
        </div>

        <div>
          <div className="text-xs uppercase text-white/55 mb-2 tracking-wider">From</div>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(PLACES) as ZoneId[]).map((z) => (
              <button
                key={z}
                onClick={() => setFrom(z)}
                className={`rounded-xl p-3 text-left active:scale-[0.98] transition-transform border ${from === z ? "border-white/80" : "border-line"}`}
                style={{ background: PLACES[z].color + (from === z ? "33" : "18") }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl" style={{ color: PLACES[z].color }}>{PLACES[z].arrow}</span>
                  <span className="text-sm font-semibold">{PLACES[z].nice}</span>
                </div>
                <div className="text-[11px] text-white/65 mt-0.5">{fansByZone[z]} phones</div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs uppercase text-white/55 mb-2 tracking-wider">To</div>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(PLACES) as ZoneId[]).map((z) => (
              <button
                key={z}
                onClick={() => setTo(z)}
                disabled={z === from}
                className={`rounded-xl p-3 text-left active:scale-[0.98] transition-transform disabled:opacity-30 border ${to === z ? "border-white/80" : "border-line"}`}
                style={{ background: PLACES[z].color + (to === z ? "33" : "18") }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl" style={{ color: PLACES[z].color }}>{PLACES[z].arrow}</span>
                  <span className="text-sm font-semibold">{PLACES[z].nice}</span>
                </div>
                <div className="text-[11px] text-white/65 mt-0.5">{PLACES[z].gate}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-ink rounded-xl p-3 text-sm border border-line">
          <span className="text-white/55">Walk from </span>
          <span className="font-semibold" style={{ color: PLACES[from].color }}>{PLACES[from].nice}</span>
          <span className="text-white/55"> to </span>
          <span className="font-semibold" style={{ color: PLACES[to].color }}>{PLACES[to].gate}</span>
        </div>

        {err && (
          <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">{err}</div>
        )}

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 rounded-xl text-sm text-white/75 border border-line hover:border-white/40 transition-colors">Cancel</button>
          <button
            onClick={send}
            disabled={sending || from === to}
            className="flex-1 py-3 rounded-xl text-white font-semibold disabled:opacity-50 active:scale-[0.98] transition-transform"
            style={{ background: "#ef4444" }}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
