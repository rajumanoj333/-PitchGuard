"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, limit } from "firebase/firestore";
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
};

export default function Page() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [zones, setZones] = useState<Zone[]>([]);

  useEffect(() => {
    const dq = query(collection(db, "decisions"), orderBy("ts", "desc"), limit(30));
    const u1 = onSnapshot(dq, (snap) => {
      setDecisions(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Decision, "id">) })));
    });
    const u2 = onSnapshot(collection(db, "zones"), (snap) => {
      setZones(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Zone, "id">) })));
    });
    return () => { u1(); u2(); };
  }, []);

  const latest = decisions[0];
  const sev = latest?.severity ?? "info";
  const sevColor =
    sev === "critical" ? "bg-crit" : sev === "warn" ? "bg-warn" : sev === "watch" ? "bg-accent/60" : "bg-accent/30";

  return (
    <main className="min-h-screen p-6 grid grid-cols-12 gap-4">
      <header className="col-span-12 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            PITCHGUARD <span className="text-accent">·</span> Command Center
          </h1>
          <p className="text-xs text-gray-400">Real-time crowd intelligence · Gemini 2.5 Flash</p>
        </div>
        <div className="flex items-center gap-3">
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

      <section className="col-span-8 bg-panel rounded-xl p-4 min-h-[420px]">
        <h2 className="text-sm uppercase text-gray-400 mb-2">Stadium overview</h2>
        <StadiumMap zones={zones} reroute={latest ? { from: latest.reroute_from_zone, to: latest.reroute_to_zone } : null} />
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
                {latest.reroute_to_gate ? ` (Gate ${latest.reroute_to_gate})` : ""}
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
        <div className="grid grid-cols-3 gap-3">
          {zones.length === 0 && (
            <p className="col-span-3 text-gray-500 text-sm">Awaiting first signal…</p>
          )}
          {zones.map((z) => {
            const c = z.density >= 4 ? "border-crit text-crit" : z.density >= 3 ? "border-warn text-warn" : "border-accent text-accent";
            return (
              <div key={z.id} className={`rounded-lg p-4 border ${c}`}>
                <p className="text-xs uppercase text-gray-400">{z.label || z.id}</p>
                <p className="text-3xl font-bold">{z.density?.toFixed(2)}</p>
                <p className="text-xs text-gray-400">people/m² · {z.headcount} total</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="col-span-4 bg-panel rounded-xl p-4 max-h-[480px] overflow-y-auto">
        <h2 className="text-sm uppercase text-gray-400 mb-2">Decision feed</h2>
        <DecisionFeed decisions={decisions} />
      </section>
    </main>
  );
}
