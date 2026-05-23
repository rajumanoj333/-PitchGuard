"use client";

/**
 * Fan page — kid-simple UI.
 *
 * 3 states only:
 *   1. WELCOME  — pick where you are sitting (4 big colored buttons)
 *   2. SAFE     — green screen "You are safe, enjoy the match"
 *   3. MOVE     — red screen "Walk to <Green Gate>" + walking map + siren
 *
 * Demo: 4 small buttons at bottom let you pretend to move between zones.
 */

import { useEffect, useRef, useState } from "react";
import {
  doc, onSnapshot, setDoc, deleteDoc,
  collection, query, where, orderBy, limit, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Loader } from "@googlemaps/js-api-loader";

type ZoneId = "NORTH" | "EAST" | "SOUTH" | "WEST";

const STADIUM_CENTER = { lat: 23.09225, lng: 72.59720 };

// Plain-English labels — no "Zone" word.
const PLACES: Record<ZoneId, { gate: string; lat: number; lng: number; nice: string; emoji: string; color: string }> = {
  NORTH: { gate: "Gate 1",  lat: 23.09365, lng: 72.59710, nice: "North Side", emoji: "⬆️", color: "#3b82f6" },
  EAST:  { gate: "Gate 5",  lat: 23.09225, lng: 72.59870, nice: "East Side",  emoji: "➡️", color: "#10b981" },
  SOUTH: { gate: "Gate 9",  lat: 23.09075, lng: 72.59720, nice: "South Side", emoji: "⬇️", color: "#f59e0b" },
  WEST:  { gate: "Gate 11", lat: 23.09225, lng: 72.59570, nice: "West Side",  emoji: "⬅️", color: "#a855f7" },
};

type Geo = { lat: number; lng: number; accuracy: number } | null;
type Decision = {
  affected_zones?: string[];
  reroute_to_zone?: string | null;
  reroute_to_gate?: string | null;
  reroute_to_lat?: number | null;
  reroute_to_lng?: number | null;
  alarm?: boolean;
  summary?: string;
};
type Alert = {
  id: string;
  zone_id: string;
  exit_gate: string;
  exit_lat: number;
  exit_lng: number;
  message: string;
};

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fanId(): string {
  const k = "pitchguard:fanId";
  let id = typeof window !== "undefined" ? localStorage.getItem(k) : null;
  if (!id) {
    id = "fan_" + Math.random().toString(36).slice(2, 11);
    if (typeof window !== "undefined") localStorage.setItem(k, id);
  }
  return id;
}

export default function FanPage() {
  const [stage, setStage] = useState<"welcome" | "active">("welcome");
  const [mySeat, setMySeat] = useState<ZoneId>("NORTH");
  const [realGeo, setRealGeo] = useState<Geo>(null);
  const [demoSeat, setDemoSeat] = useState<ZoneId | null>(null);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [alert, setAlert] = useState<Alert | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sirenStopRef = useRef<(() => void) | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const idRef = useRef<string>("");

  useEffect(() => { idRef.current = fanId(); }, []);

  const here: ZoneId = demoSeat ?? mySeat;
  const pos = demoSeat
    ? { lat: PLACES[demoSeat].lat, lng: PLACES[demoSeat].lng, accuracy: 5 }
    : realGeo;

  // --- Subscriptions ---
  useEffect(() => {
    const u = onSnapshot(doc(db, "live", "current"), (s) => {
      const d = s.data() as Decision | undefined;
      if (d) setDecision(d);
    });
    return () => u();
  }, []);

  useEffect(() => {
    if (stage !== "active") return;
    const q = query(
      collection(db, "alerts"),
      where("zone_id", "==", here),
      orderBy("ts", "desc"),
      limit(1),
    );
    const u = onSnapshot(q, (snap) => {
      const d = snap.docs[0];
      setAlert(d ? { id: d.id, ...(d.data() as Omit<Alert, "id">) } : null);
    });
    return () => u();
  }, [stage, here]);

  // Heartbeat: write our position so operator sees us
  useEffect(() => {
    if (stage !== "active" || !pos) return;
    const id = idRef.current;
    const tick = async () => {
      try {
        await setDoc(doc(db, "fans", id), {
          name: "Fan",
          zone: here,
          lat: pos.lat,
          lng: pos.lng,
          accuracy: Math.min(999, Math.round(pos.accuracy)),
          ts: serverTimestamp(),
          ua: navigator.userAgent.slice(0, 80),
        });
      } catch {}
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [stage, pos?.lat, pos?.lng, here]);

  useEffect(() => {
    if (stage !== "active") return;
    const id = idRef.current;
    const cleanup = () => deleteDoc(doc(db, "fans", id)).catch(() => {});
    window.addEventListener("beforeunload", cleanup);
    return () => window.removeEventListener("beforeunload", cleanup);
  }, [stage]);

  // Move-now state
  const brainMove =
    !!decision?.alarm && (decision.affected_zones || []).includes(here);
  const moveNow = stage === "active" && (brainMove || !!alert);

  const target = alert
    ? { gate: alert.exit_gate, lat: alert.exit_lat, lng: alert.exit_lng, why: alert.message }
    : decision?.alarm && decision.reroute_to_lat && decision.reroute_to_lng
    ? {
        gate: decision.reroute_to_gate || "Safe Gate",
        lat: decision.reroute_to_lat,
        lng: decision.reroute_to_lng,
        why: decision.summary || "Too many people near you. Walk to the green gate.",
      }
    : null;

  // Siren when moving
  useEffect(() => {
    if (moveNow) {
      startSiren();
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 600]);
    } else {
      stopSiren();
    }
    return () => stopSiren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveNow]);

  function startSiren() {
    const ctx = audioCtxRef.current;
    if (!ctx || sirenStopRef.current) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.3;
    const now = ctx.currentTime;
    for (let i = 0; i < 60; i++) {
      osc.frequency.setValueAtTime(i % 2 === 0 ? 700 : 1100, now + i * 0.4);
    }
    osc.start(now);
    osc.stop(now + 24);
    sirenStopRef.current = () => {
      try { osc.stop(); } catch {}
      sirenStopRef.current = null;
    };
  }
  function stopSiren() { sirenStopRef.current?.(); }

  // Start: unlock audio + GPS
  async function start(seat: ZoneId) {
    setMySeat(seat);
    try {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new Ctor();
      await ctx.resume();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start(0);
      audioCtxRef.current = ctx;
    } catch {}

    if ("geolocation" in navigator) {
      try {
        const id = navigator.geolocation.watchPosition(
          (p) => {
            setRealGeo({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
            setGeoErr(null);
          },
          (err) => setGeoErr(err.message),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        );
        watchIdRef.current = id;
      } catch (e: any) { setGeoErr(e?.message || "GPS error"); }
    } else {
      setGeoErr("Phone does not support location");
    }
    setStage("active");
  }

  useEffect(() => () => {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    stopSiren();
  }, []);

  const distance = pos && target ? metersBetween(pos, target) : null;

  // ─────────────── WELCOME SCREEN ───────────────
  if (stage === "welcome") {
    return (
      <main className="min-h-screen bg-ink p-5 flex flex-col gap-5">
        <div className="text-center pt-4">
          <p className="text-3xl mb-2">🏟️</p>
          <p className="text-2xl font-bold">Stadium Safety</p>
          <p className="text-sm text-gray-400 mt-1">Tap your seating side to begin</p>
        </div>

        <div className="grid grid-cols-2 gap-4 mt-4">
          {(Object.keys(PLACES) as ZoneId[]).map((z) => (
            <button
              key={z}
              onClick={() => start(z)}
              className="rounded-2xl p-5 flex flex-col items-center gap-2 active:scale-95 shadow-lg"
              style={{ background: PLACES[z].color }}
            >
              <span className="text-4xl">{PLACES[z].emoji}</span>
              <span className="text-white font-bold text-lg">{PLACES[z].nice}</span>
              <span className="text-white/80 text-xs">{PLACES[z].gate}</span>
            </button>
          ))}
        </div>

        <div className="bg-panel rounded-xl p-4 mt-3 text-sm text-gray-300 space-y-1">
          <p className="font-bold text-white">How it works</p>
          <p>1. Pick where you are sitting.</p>
          <p>2. Allow Location and Sound when asked.</p>
          <p>3. We will buzz your phone if you need to move.</p>
          <p>4. Follow the green line on the map.</p>
        </div>

        <footer className="mt-auto text-center text-[10px] text-gray-600">
          Narendra Modi Stadium · Powered by Google Cloud
        </footer>
      </main>
    );
  }

  // ─────────────── ACTIVE SCREEN ───────────────
  return (
    <main
      className={`min-h-screen p-4 flex flex-col gap-3 transition-colors ${
        moveNow ? "bg-crit animate-pulse" : "bg-ink"
      }`}
    >
      <header className="flex items-center justify-between">
        <p className="text-base font-bold">🏟️ Stadium Safety</p>
        <span className="text-[10px] px-2 py-1 rounded bg-accent text-ink font-bold">ON</span>
      </header>

      {/* Where am I */}
      <div className="bg-panel rounded-xl p-3 flex items-center gap-3">
        <span className="text-3xl">{PLACES[here].emoji}</span>
        <div className="flex-1">
          <p className="text-[10px] text-gray-400 uppercase">You are at</p>
          <p className="text-lg font-bold text-white">{PLACES[here].nice}</p>
          {demoSeat && <p className="text-[10px] text-warn">(pretend mode)</p>}
        </div>
        <div className="text-right">
          {pos ? (
            <p className="text-[10px] text-accent">📍 GPS on</p>
          ) : (
            <p className="text-[10px] text-warn">{geoErr || "📍 finding…"}</p>
          )}
        </div>
      </div>

      {/* Big map */}
      <MiniMap pos={pos} here={here} moveNow={moveNow} target={target} />

      {/* Status card */}
      {moveNow && target ? (
        <div className="bg-black border-4 border-white rounded-xl p-4 space-y-3">
          <div className="text-center">
            <p className="text-5xl mb-1">🚨</p>
            <p className="text-xs uppercase tracking-widest text-white/80">Move now</p>
            <p className="text-2xl font-black mt-1">Walk to {target.gate}</p>
          </div>
          {distance != null && (
            <div className="bg-white/10 rounded-lg py-3 text-center">
              <p className="text-xs uppercase text-white/70">How far</p>
              <p className="text-4xl font-bold">{Math.round(distance)} m</p>
              <p className="text-[10px] text-white/60">about {Math.round(distance / 75)} min walk</p>
            </div>
          )}
          <p className="text-sm leading-snug text-center">{target.why}</p>
          {pos && (
            <a
              href={`https://www.google.com/maps/dir/?api=1&origin=${pos.lat},${pos.lng}&destination=${target.lat},${target.lng}&travelmode=walking`}
              target="_blank"
              rel="noreferrer"
              className="block text-center bg-white text-crit font-bold py-3 rounded-lg text-base"
            >
              🗺️ Open in Google Maps
            </a>
          )}
          <button
            onClick={stopSiren}
            className="block w-full text-center text-[11px] text-white/70 underline"
          >
            Quiet the sound (keep map)
          </button>
        </div>
      ) : (
        <div className="bg-green-600/20 border border-green-500 rounded-xl p-5 text-center">
          <p className="text-5xl mb-2">✅</p>
          <p className="text-xl font-bold text-green-300">You are safe</p>
          <p className="text-sm text-gray-300 mt-1">Enjoy the match!</p>
        </div>
      )}

      {/* Demo controls */}
      <div className="bg-panel/60 border border-gray-700 rounded-xl p-3">
        <p className="text-[10px] uppercase text-gray-400 mb-2">For demo: pretend I moved to</p>
        <div className="grid grid-cols-4 gap-2">
          {(Object.keys(PLACES) as ZoneId[]).map((z) => (
            <button
              key={z}
              onClick={() => setDemoSeat(z)}
              className={`text-xs py-2 rounded font-bold ${
                demoSeat === z
                  ? "text-white"
                  : "bg-gray-700 text-gray-200"
              }`}
              style={demoSeat === z ? { background: PLACES[z].color } : undefined}
            >
              {PLACES[z].emoji}<br />{PLACES[z].nice.split(" ")[0]}
            </button>
          ))}
        </div>
        {demoSeat && (
          <button
            onClick={() => setDemoSeat(null)}
            className="mt-2 w-full text-[10px] text-gray-400 underline"
          >
            Use my real location
          </button>
        )}
      </div>

      <footer className="text-center text-[10px] text-gray-600">
        Powered by Google Cloud · Live safety alerts
      </footer>
    </main>
  );
}

function MiniMap({
  pos,
  here,
  moveNow,
  target,
}: {
  pos: Geo;
  here: ZoneId;
  moveNow: boolean;
  target: { lat: number; lng: number; gate: string } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const meRef = useRef<google.maps.Marker | null>(null);
  const gatesRef = useRef<google.maps.Marker[]>([]);
  const dirSvcRef = useRef<google.maps.DirectionsService | null>(null);
  const dirRendRef = useRef<google.maps.DirectionsRenderer | null>(null);
  const lastKey = useRef<string>("");

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !ref.current) return;
    new Loader({ apiKey: key, version: "weekly" }).load().then(() => {
      mapRef.current = new google.maps.Map(ref.current!, {
        center: STADIUM_CENTER,
        zoom: 17,
        mapTypeId: "hybrid",
        disableDefaultUI: true,
        gestureHandling: "greedy",
      });
      (Object.keys(PLACES) as ZoneId[]).forEach((z) => {
        const m = new google.maps.Marker({
          position: { lat: PLACES[z].lat, lng: PLACES[z].lng },
          map: mapRef.current!,
          label: { text: PLACES[z].gate, color: "#fff", fontSize: "10px", fontWeight: "bold" },
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 6,
            fillColor: PLACES[z].color,
            fillOpacity: 0.95,
            strokeColor: "#fff",
            strokeWeight: 1.5,
          },
        });
        gatesRef.current.push(m);
      });
      dirSvcRef.current = new google.maps.DirectionsService();
      dirRendRef.current = new google.maps.DirectionsRenderer({
        map: mapRef.current!,
        suppressMarkers: true,
        polylineOptions: { strokeColor: "#22c55e", strokeWeight: 7, strokeOpacity: 0.95 },
      });
    });
  }, []);

  useEffect(() => {
    if (!mapRef.current || !pos) return;
    const p = { lat: pos.lat, lng: pos.lng };
    const icon = {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 11,
      fillColor: moveNow ? "#ef4444" : "#22d3ee",
      fillOpacity: 0.95,
      strokeColor: "#fff",
      strokeWeight: 3,
    };
    if (meRef.current) {
      meRef.current.setPosition(p);
      meRef.current.setIcon(icon);
    } else {
      meRef.current = new google.maps.Marker({
        position: p,
        map: mapRef.current,
        icon,
        label: { text: "Me", color: "#fff", fontSize: "11px", fontWeight: "bold" },
      });
    }
  }, [pos?.lat, pos?.lng, moveNow]);

  useEffect(() => {
    if (!mapRef.current || !dirSvcRef.current || !dirRendRef.current) return;
    if (!moveNow || !pos || !target) {
      dirRendRef.current.set("directions", null);
      lastKey.current = "";
      return;
    }
    const k = `${pos.lat.toFixed(4)},${pos.lng.toFixed(4)}|${target.lat},${target.lng}`;
    if (k === lastKey.current) return;
    lastKey.current = k;
    dirSvcRef.current.route(
      {
        origin: { lat: pos.lat, lng: pos.lng },
        destination: { lat: target.lat, lng: target.lng },
        travelMode: google.maps.TravelMode.WALKING,
      },
      (res, status) => {
        if (status === "OK" && res) dirRendRef.current!.setDirections(res);
      },
    );
    const b = new google.maps.LatLngBounds();
    b.extend({ lat: pos.lat, lng: pos.lng });
    b.extend({ lat: target.lat, lng: target.lng });
    mapRef.current.fitBounds(b, { top: 60, right: 40, bottom: 60, left: 40 });
  }, [moveNow, pos?.lat, pos?.lng, target?.lat, target?.lng]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return (
      <div className="h-[260px] flex items-center justify-center text-gray-500 text-xs">
        Map key missing
      </div>
    );
  }
  return <div ref={ref} className="h-[280px] w-full rounded-xl overflow-hidden" />;
}
