"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query, limit } from "firebase/firestore";
import { db } from "@/lib/firebase";
import StadiumMap from "@/components/StadiumMap";

type Decision = {
  id: string;
  severity: "info" | "watch" | "warn" | "critical";
  summary: string;
  actions: string[];
  affected_zones?: string[];
  reroute_from_zone?: string | null;
  reroute_to_zone?: string | null;
  reroute_to_gate?: string | null;
  alarm?: boolean;
  ts?: { seconds: number } | null;
};
type Zone = {
  id: string;
  headcount: number;
  density: number;
  label?: string;
  lat?: number;
  lng?: number;
};
type Fan = {
  id: string;
  name: string;
  zone: "NORTH" | "EAST" | "SOUTH" | "WEST";
  lat: number;
  lng: number;
};
type ZoneId = "NORTH" | "EAST" | "SOUTH" | "WEST";

const BRAIN = process.env.NEXT_PUBLIC_BRAIN_URL || "";

const PLACES: Record<ZoneId, { gate: string; lat: number; lng: number; nice: string; emoji: string; color: string }> = {
  NORTH: { gate: "Gate 1",  lat: 23.09365, lng: 72.59710, nice: "North Side", emoji: "⬆️", color: "#3b82f6" },
  EAST:  { gate: "Gate 5",  lat: 23.09225, lng: 72.59870, nice: "East Side",  emoji: "➡️", color: "#10b981" },
  SOUTH: { gate: "Gate 9",  lat: 23.09075, lng: 72.59720, nice: "South Side", emoji: "⬇️", color: "#f59e0b" },
  WEST:  { gate: "Gate 11", lat: 23.09225, lng: 72.59570, nice: "West Side",  emoji: "⬅️", color: "#a855f7" },
};

// Plain-English crowd labels
function crowdWord(density: number): { word: string; color: string } {
  if (density >= 4) return { word: "TOO MANY", color: "#ef4444" };
  if (density >= 3) return { word: "Crowded",  color: "#f59e0b" };
  if (density >= 1.5) return { word: "Busy",   color: "#22d3ee" };
  return { word: "Calm", color: "#10b981" };
}

export default function Page() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [fans, setFans] = useState<Fan[]>([]);
  const [showMove, setShowMove] = useState(false);

  useEffect(() => {
    const u1 = onSnapshot(
      query(collection(db, "decisions"), orderBy("ts", "desc"), limit(10)),
      (snap) => setDecisions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Decision, "id">) }))),
    );
    const u2 = onSnapshot(collection(db, "zones"), (snap) =>
      setZones(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Zone, "id">) }))),
    );
    const u3 = onSnapshot(collection(db, "fans"), (snap) =>
      setFans(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Fan, "id">) }))),
    );
    return () => { u1(); u2(); u3(); };
  }, []);

  const latest = decisions[0];
  const fansByZone = useMemo(() => {
    const m: Record<string, number> = { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 };
    for (const f of fans) m[f.zone] = (m[f.zone] || 0) + 1;
    return m;
  }, [fans]);

  // Find the worst zone for default suggestion in modal
  const worstZone = useMemo(() => {
    if (!zones.length) return "NORTH" as ZoneId;
    return zones.slice().sort((a, b) => (b.density || 0) - (a.density || 0))[0].id as ZoneId;
  }, [zones]);
  const safestZone = useMemo(() => {
    if (!zones.length) return "SOUTH" as ZoneId;
    return zones.slice().sort((a, b) => (a.density || 0) - (b.density || 0))[0].id as ZoneId;
  }, [zones]);

  const status = !latest
    ? { word: "All Good", color: "#10b981", icon: "✅" }
    : latest.severity === "critical"
    ? { word: "MOVE PEOPLE NOW", color: "#ef4444", icon: "🚨" }
    : latest.severity === "warn"
    ? { word: "Crowd Building", color: "#f59e0b", icon: "⚠️" }
    : latest.severity === "watch"
    ? { word: "Keep Watching", color: "#22d3ee", icon: "👀" }
    : { word: "All Good", color: "#10b981", icon: "✅" };

  return (
    <main className="min-h-screen p-5 bg-ink text-white">
      {/* Title bar */}
      <header className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-3xl font-black tracking-tight">🏟️ Control Room</h1>
          <p className="text-xs text-gray-400">Narendra Modi Stadium · {fans.length} people watching</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowMove(true)}
            className="bg-crit text-white px-5 py-3 rounded-xl font-black text-base active:scale-95 shadow-lg"
          >
            🚨 Move People
          </button>
          <a
            href="/fan"
            className="bg-panel border border-accent text-accent px-4 py-3 rounded-xl text-sm font-bold"
          >
            Open Fan Phone →
          </a>
        </div>
      </header>

      {/* Giant status banner */}
      <div
        className="rounded-2xl p-4 mb-4 flex items-center gap-4 shadow-lg"
        style={{ background: `${status.color}22`, border: `2px solid ${status.color}` }}
      >
        <span className="text-5xl">{status.icon}</span>
        <div>
          <p className="text-xs uppercase text-gray-300">Right now</p>
          <p className="text-3xl font-black" style={{ color: status.color }}>{status.word}</p>
          {latest?.summary && <p className="text-sm text-gray-300 mt-1">{latest.summary}</p>}
        </div>
      </div>

      {/* Two columns: map + 4 zone cards */}
      <div className="grid grid-cols-12 gap-4">
        <section className="col-span-8 bg-panel rounded-2xl p-4">
          <p className="text-xs uppercase text-gray-400 mb-2">Stadium map · live phones</p>
          <StadiumMap
            zones={zones}
            fans={fans}
            reroute={latest ? { from: latest.reroute_from_zone, to: latest.reroute_to_zone } : null}
          />
        </section>

        <section className="col-span-4 space-y-3">
          {(Object.keys(PLACES) as ZoneId[]).map((zid) => {
            const z = zones.find((x) => x.id === zid);
            const density = z?.density ?? 0;
            const word = crowdWord(density);
            return (
              <div
                key={zid}
                className="rounded-xl p-4 border-l-8 bg-panel"
                style={{ borderLeftColor: word.color }}
              >
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{PLACES[zid].emoji}</span>
                  <div className="flex-1">
                    <p className="text-sm font-bold">{PLACES[zid].nice}</p>
                    <p className="text-[10px] text-gray-400">{PLACES[zid].gate}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-black" style={{ color: word.color }}>{word.word}</p>
                    <p className="text-[10px] text-gray-400">📱 {fansByZone[zid]} phones</p>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </div>

      {/* Bottom: simple help */}
      <section className="mt-4 bg-panel rounded-2xl p-4 grid grid-cols-3 gap-4 text-xs text-gray-300">
        <div>
          <p className="text-accent font-bold text-sm mb-1">1. Watch the map</p>
          <p>Big colored circles show how crowded each side is. Red = too many.</p>
        </div>
        <div>
          <p className="text-accent font-bold text-sm mb-1">2. AI alerts you</p>
          <p>If crowd gets dangerous, banner turns red and tells you what to do.</p>
        </div>
        <div>
          <p className="text-accent font-bold text-sm mb-1">3. Move people</p>
          <p>Tap <span className="text-crit font-bold">🚨 Move People</span> to send everyone in one side to a safer gate.</p>
        </div>
      </section>

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

  async function send() {
    if (!BRAIN) { alert("Brain URL not set"); return; }
    setSending(true);
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
          message: `Please walk to ${target.gate} on the ${PLACES[to].nice}. Stay calm and follow the green line on your phone.`,
          severity: "critical",
          operator: "control-room",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onClose();
    } catch (e: any) {
      alert(`Failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div className="bg-panel rounded-3xl border-2 border-crit max-w-md w-full p-6 space-y-5">
        <div className="text-center">
          <p className="text-4xl mb-1">🚨</p>
          <p className="text-2xl font-black">Move People</p>
          <p className="text-xs text-gray-400">All phones in the chosen side will buzz and see a green line</p>
        </div>

        <div>
          <p className="text-xs text-gray-400 uppercase mb-2">Who needs to move?</p>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(PLACES) as ZoneId[]).map((z) => (
              <button
                key={z}
                onClick={() => setFrom(z)}
                className={`p-3 rounded-xl text-left ${from === z ? "ring-4 ring-white" : ""}`}
                style={{ background: PLACES[z].color }}
              >
                <p className="text-xl">{PLACES[z].emoji}</p>
                <p className="text-white font-bold text-sm">{PLACES[z].nice}</p>
                <p className="text-white/80 text-[10px]">📱 {fansByZone[z]} phones</p>
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs text-gray-400 uppercase mb-2">Where should they go?</p>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(PLACES) as ZoneId[]).map((z) => (
              <button
                key={z}
                onClick={() => setTo(z)}
                disabled={z === from}
                className={`p-3 rounded-xl text-left disabled:opacity-30 ${to === z ? "ring-4 ring-white" : ""}`}
                style={{ background: PLACES[z].color }}
              >
                <p className="text-xl">{PLACES[z].emoji}</p>
                <p className="text-white font-bold text-sm">{PLACES[z].nice}</p>
                <p className="text-white/80 text-[10px]">{PLACES[z].gate}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="bg-ink rounded-xl p-3 text-sm">
          <p className="text-gray-400 text-xs mb-1">Phones will see:</p>
          <p className="text-white">
            Walk from <span style={{ color: PLACES[from].color }} className="font-bold">{PLACES[from].nice}</span>
            {" → "}
            <span style={{ color: PLACES[to].color }} className="font-bold">{PLACES[to].gate}</span>
          </p>
        </div>

        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 py-3 text-sm text-gray-300 bg-gray-700 rounded-xl">
            Cancel
          </button>
          <button
            onClick={send}
            disabled={sending || from === to}
            className="flex-1 py-3 bg-crit text-white font-black rounded-xl disabled:opacity-50"
          >
            {sending ? "Sending…" : "🚨 Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
