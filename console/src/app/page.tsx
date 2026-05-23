"use client";

import { useEffect, useMemo, useState } from "react";
import {
  collection, onSnapshot, orderBy, query, limit,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import DecisionFeed from "@/components/DecisionFeed";
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
  gate_id?: string;
  lat?: number;
  lng?: number;
};

type Fan = {
  id: string;
  name: string;
  zone: "NORTH" | "EAST" | "SOUTH" | "WEST";
  lat: number;
  lng: number;
  accuracy?: number;
  ts?: { seconds: number } | null;
};

type ZoneId = "NORTH" | "EAST" | "SOUTH" | "WEST";

const BRAIN = process.env.NEXT_PUBLIC_BRAIN_URL || "";
const ZONES: Record<ZoneId, { gate: string; lat: number; lng: number; label: string }> = {
  NORTH: { gate: "Gate 1",  lat: 23.09365, lng: 72.59710, label: "North · Gate 1" },
  EAST:  { gate: "Gate 5",  lat: 23.09225, lng: 72.59870, label: "East · Gate 5" },
  SOUTH: { gate: "Gate 9",  lat: 23.09075, lng: 72.59720, label: "South · Gate 9" },
  WEST:  { gate: "Gate 11", lat: 23.09225, lng: 72.59570, label: "West · Gate 11" },
};

export default function Page() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);
  const [fans, setFans] = useState<Fan[]>([]);
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertSending, setAlertSending] = useState(false);

  useEffect(() => {
    const dq = query(collection(db, "decisions"), orderBy("ts", "desc"), limit(30));
    const u1 = onSnapshot(dq, (snap) => {
      setDecisions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Decision, "id">) })));
    });
    const u2 = onSnapshot(collection(db, "zones"), (snap) => {
      setZones(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Zone, "id">) })));
    });
    const u3 = onSnapshot(collection(db, "fans"), (snap) => {
      setFans(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Fan, "id">) })));
    });
    return () => { u1(); u2(); u3(); };
  }, []);

  const latest = decisions[0];
  const sev = latest?.severity ?? "info";
  const sevColor =
    sev === "critical" ? "bg-crit" : sev === "warn" ? "bg-warn" : sev === "watch" ? "bg-accent/60" : "bg-accent/30";

  const fansByZone = useMemo(() => {
    const m: Record<string, number> = { NORTH: 0, EAST: 0, SOUTH: 0, WEST: 0 };
    for (const f of fans) m[f.zone] = (m[f.zone] || 0) + 1;
    return m;
  }, [fans]);

  return (
    <main className="min-h-screen p-6 grid grid-cols-12 gap-4">
      <header className="col-span-12 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            PITCHGUARD <span className="text-accent">·</span> Command Center
          </h1>
          <p className="text-xs text-gray-400">
            Narendra Modi Stadium, Ahmedabad · Gemini 2.5 Flash · {fans.length} fans live
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowAlertModal(true)}
            className="text-xs bg-crit text-white px-4 py-2 rounded font-bold active:scale-95"
          >
            🚨 Send Alert
          </button>
          <a
            href="/fan"
            className="text-xs bg-panel border border-accent text-accent px-3 py-2 rounded hover:bg-accent hover:text-ink"
          >
            Open Fan Beacon →
          </a>
          <div className={`px-4 py-2 rounded ${sevColor} text-ink font-bold uppercase`}>
            {sev}
          </div>
        </div>
      </header>

      <section className="col-span-8 bg-panel rounded-xl p-4 min-h-[480px]">
        <h2 className="text-sm uppercase text-gray-400 mb-2">
          Stadium overview · {fans.length} live fans
        </h2>
        <StadiumMap
          zones={zones}
          fans={fans}
          reroute={latest ? { from: latest.reroute_from_zone, to: latest.reroute_to_zone } : null}
        />
      </section>

      <section className="col-span-4 bg-panel rounded-xl p-4">
        <h2 className="text-sm uppercase text-gray-400 mb-2">Latest decision</h2>
        {latest ? (
          <div className="space-y-2">
            <p className="text-lg leading-snug">{latest.summary}</p>
            <ul className="text-sm space-y-1 list-disc list-inside text-gray-300">
              {latest.actions?.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
            {latest.reroute_to_zone && (
              <p className="text-accent text-sm">
                → Reroute Zone {latest.reroute_from_zone} fans to Zone {latest.reroute_to_zone}
                {latest.reroute_to_gate ? ` (${latest.reroute_to_gate})` : ""}
              </p>
            )}
            {latest.alarm && (
              <p className="text-crit text-sm font-bold animate-pulse">🚨 Fan beacons triggered</p>
            )}
          </div>
        ) : (
          <p className="text-gray-500">Waiting for signals…</p>
        )}
      </section>

      <section className="col-span-8 bg-panel rounded-xl p-4">
        <h2 className="text-sm uppercase text-gray-400 mb-2">Live zones</h2>
        <div className="grid grid-cols-4 gap-3">
          {(Object.keys(ZONES) as ZoneId[]).map((zid) => {
            const z = zones.find((x) => x.id === zid);
            const density = z?.density ?? 0;
            const c = density >= 4 ? "border-crit text-crit" : density >= 3 ? "border-warn text-warn" : "border-accent text-accent";
            return (
              <div key={zid} className={`rounded-lg p-3 border ${c}`}>
                <p className="text-xs uppercase text-gray-400">{ZONES[zid].label}</p>
                <p className="text-2xl font-bold">{density.toFixed(2)}</p>
                <p className="text-[10px] text-gray-400">people/m² · {z?.headcount ?? 0} total</p>
                <p className="text-[10px] text-accent mt-1">{fansByZone[zid] || 0} live fans 📱</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="col-span-4 bg-panel rounded-xl p-4 max-h-[480px] overflow-y-auto">
        <h2 className="text-sm uppercase text-gray-400 mb-2">Decision feed</h2>
        <DecisionFeed decisions={decisions} />
      </section>

      {showAlertModal && (
        <SendAlertModal
          onClose={() => setShowAlertModal(false)}
          fansByZone={fansByZone}
          sending={alertSending}
          setSending={setAlertSending}
        />
      )}
    </main>
  );
}

function SendAlertModal({
  onClose,
  fansByZone,
  sending,
  setSending,
}: {
  onClose: () => void;
  fansByZone: Record<string, number>;
  sending: boolean;
  setSending: (b: boolean) => void;
}) {
  const [zone, setZone] = useState<ZoneId>("NORTH");
  const [exit, setExit] = useState<ZoneId>("SOUTH");
  const [message, setMessage] = useState(
    "Heavy congestion in your zone. Walk calmly to the indicated exit.",
  );
  const [severity, setSeverity] = useState<"warn" | "critical">("critical");

  async function send() {
    if (!BRAIN) return;
    setSending(true);
    try {
      const target = ZONES[exit];
      const res = await fetch(`${BRAIN}/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          zone_id: zone,
          exit_gate: target.gate,
          exit_lat: target.lat,
          exit_lng: target.lng,
          message,
          severity,
          operator: "control-room",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onClose();
    } catch (e: any) {
      alert(`Alert failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4">
      <div className="bg-panel rounded-2xl border border-gray-700 max-w-md w-full p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">Send manual alert</h3>
          <button onClick={onClose} className="text-gray-400 text-xl">✕</button>
        </div>

        <label className="block text-xs text-gray-400">
          From zone (fans here receive)
          <select
            value={zone}
            onChange={(e) => setZone(e.target.value as ZoneId)}
            className="mt-1 bg-ink border border-gray-700 rounded w-full px-3 py-2 text-white"
          >
            {(Object.keys(ZONES) as ZoneId[]).map((z) => (
              <option key={z} value={z}>
                {ZONES[z].label} ({fansByZone[z] || 0} fans)
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-gray-400">
          To exit gate
          <select
            value={exit}
            onChange={(e) => setExit(e.target.value as ZoneId)}
            className="mt-1 bg-ink border border-gray-700 rounded w-full px-3 py-2 text-white"
          >
            {(Object.keys(ZONES) as ZoneId[]).map((z) => (
              <option key={z} value={z}>{ZONES[z].label}</option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-gray-400">
          Severity
          <div className="mt-1 flex gap-2">
            {(["warn", "critical"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSeverity(s)}
                className={`px-3 py-1 rounded text-xs ${
                  severity === s
                    ? s === "critical" ? "bg-crit text-white" : "bg-warn text-ink"
                    : "bg-gray-700 text-gray-300"
                }`}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
        </label>

        <label className="block text-xs text-gray-400">
          Message ({message.length}/240)
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 240))}
            rows={3}
            className="mt-1 bg-ink border border-gray-700 rounded w-full px-3 py-2 text-white text-sm"
          />
        </label>

        <div className="flex gap-3 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-300">Cancel</button>
          <button
            onClick={send}
            disabled={sending}
            className="px-5 py-2 bg-crit text-white font-bold rounded text-sm disabled:opacity-50"
          >
            {sending ? "Sending…" : "🚨 Send to fans"}
          </button>
        </div>
      </div>
    </div>
  );
}
