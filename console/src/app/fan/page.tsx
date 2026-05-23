"use client";

/**
 * Fan page — kid-simple. Asks for name + seat. Shows YOUR own GPS pin on a
 * small Google Map. Big red move-now alert with arrow + distance.
 */

import { useEffect, useRef, useState } from "react";
import {
  doc, onSnapshot, setDoc, deleteDoc,
  collection, query, where, orderBy, limit, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Loader } from "@googlemaps/js-api-loader";

type ZoneId = "NORTH" | "EAST" | "SOUTH" | "WEST";

const PLACES: Record<ZoneId, { gate: string; lat: number; lng: number; nice: string; arrow: string; color: string }> = {
  NORTH: { gate: "Gate 1",  lat: 23.09365, lng: 72.59710, nice: "North Side", arrow: "↑", color: "#3b82f6" },
  EAST:  { gate: "Gate 5",  lat: 23.09225, lng: 72.59870, nice: "East Side",  arrow: "→", color: "#10b981" },
  SOUTH: { gate: "Gate 9",  lat: 23.09075, lng: 72.59720, nice: "South Side", arrow: "↓", color: "#f59e0b" },
  WEST:  { gate: "Gate 11", lat: 23.09225, lng: 72.59570, nice: "West Side",  arrow: "←", color: "#a855f7" },
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
  ts?: { seconds: number; nanoseconds?: number } | null;
};

// Treat alerts as actionable only within this window. Older docs in Firestore
// are history, not commands.
const ALERT_FRESH_MS = 3 * 60 * 1000;

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

function targetZoneFromCoords(lat: number, lng: number): ZoneId {
  let best: ZoneId = "SOUTH";
  let min = Infinity;
  (Object.keys(PLACES) as ZoneId[]).forEach((z) => {
    const d = metersBetween({ lat, lng }, PLACES[z]);
    if (d < min) { min = d; best = z; }
  });
  return best;
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

function savedName(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("pitchguard:name") || "";
}

export default function FanPage() {
  const [stage, setStage] = useState<"welcome" | "active">("welcome");
  const [name, setName] = useState<string>("");
  const [mySeat, setMySeat] = useState<ZoneId>("NORTH");
  const [realGeo, setRealGeo] = useState<Geo>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [liveAlert, setLiveAlert] = useState<Alert | null>(null);
  const [link, setLink] = useState({ gps: "off", write: "off", listen: "off", lastErr: "" });
  const [, setNowTick] = useState(0);
  const subStartRef = useRef<number>(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sirenStopRef = useRef<(() => void) | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const idRef = useRef<string>("");

  useEffect(() => {
    idRef.current = fanId();
    setName(savedName());
  }, []);

  const pos = realGeo ?? (stage === "active"
    ? { lat: PLACES[mySeat].lat, lng: PLACES[mySeat].lng, accuracy: 999 }
    : null);

  // Live decision from brain
  useEffect(() => {
    return onSnapshot(
      doc(db, "live", "current"),
      (s) => { const d = s.data() as Decision | undefined; if (d) setDecision(d); },
      (err) => setLink((p) => ({ ...p, lastErr: `live: ${err.message}` })),
    );
  }, []);

  // Manual operator alerts targeted at my zone.
  // Reset on seat change so previously triggered move-now state doesn't leak.
  useEffect(() => {
    if (stage !== "active") return;
    setLiveAlert(null);
    setLink((p) => ({ ...p, listen: "subscribing" }));
    subStartRef.current = Date.now();
    const q = query(
      collection(db, "alerts"),
      where("zone_id", "==", mySeat),
      orderBy("ts", "desc"),
      limit(1),
    );
    return onSnapshot(
      q,
      (snap) => {
        const d = snap.docs[0];
        setLiveAlert(d ? { id: d.id, ...(d.data() as Omit<Alert, "id">) } : null);
        setLink((p) => ({ ...p, listen: "live" }));
      },
      (err) => setLink((p) => ({ ...p, listen: "error", lastErr: `alerts: ${err.message}` })),
    );
  }, [stage, mySeat]);

  // Tick every 20s so freshness check + "last seen" UI re-render
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 20_000);
    return () => clearInterval(id);
  }, []);

  // Heartbeat — writes my real name + zone + GPS
  useEffect(() => {
    if (stage !== "active" || !pos) return;
    const id = idRef.current;
    const tick = () =>
      setDoc(doc(db, "fans", id), {
        name: name || "Fan",
        zone: mySeat,
        lat: pos.lat,
        lng: pos.lng,
        accuracy: Math.min(999, Math.round(pos.accuracy || 99)),
        ts: serverTimestamp(),
        ua: navigator.userAgent.slice(0, 80),
      })
        .then(() => setLink((p) => ({ ...p, write: "ok" })))
        .catch((e) => setLink((p) => ({ ...p, write: "error", lastErr: `write: ${e?.message || e}` })));
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [stage, pos?.lat, pos?.lng, mySeat, name]);

  useEffect(() => {
    if (stage !== "active") return;
    const id = idRef.current;
    const cleanup = () => deleteDoc(doc(db, "fans", id)).catch(() => {});
    window.addEventListener("beforeunload", cleanup);
    return () => window.removeEventListener("beforeunload", cleanup);
  }, [stage]);

  const brainMove = !!decision?.alarm && (decision.affected_zones || []).includes(mySeat);
  const alertAgeMs =
    liveAlert?.ts?.seconds != null ? Date.now() - liveAlert.ts.seconds * 1000 : Infinity;
  // Only fire move-now if alert is fresh AND landed after this subscription opened.
  // Stops historic alerts in Firestore from instantly triggering when a fan
  // picks a new seat that already had old alerts.
  const alertActionable =
    !!liveAlert &&
    alertAgeMs < ALERT_FRESH_MS &&
    (liveAlert?.ts?.seconds || 0) * 1000 >= subStartRef.current - 1000;
  const moveNow = stage === "active" && (brainMove || alertActionable);

  const target =
    alertActionable && liveAlert
      ? { gate: liveAlert.exit_gate, lat: liveAlert.exit_lat, lng: liveAlert.exit_lng, why: liveAlert.message }
      : brainMove && decision?.reroute_to_lat && decision?.reroute_to_lng
      ? {
          gate: decision.reroute_to_gate || "Safe Gate",
          lat: decision.reroute_to_lat,
          lng: decision.reroute_to_lng,
          why: decision.summary || "Too many people. Walk to the safe gate.",
        }
      : null;

  const targetZoneId: ZoneId | null = target ? targetZoneFromCoords(target.lat, target.lng) : null;
  const distance = pos && target ? metersBetween(pos, target) : null;
  const minutes = distance != null ? Math.max(1, Math.round(distance / 75)) : null;

  useEffect(() => {
    if (moveNow) {
      startSiren();
      if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 800]);
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
    gain.gain.value = 0.35;
    const now = ctx.currentTime;
    for (let i = 0; i < 60; i++) {
      osc.frequency.setValueAtTime(i % 2 === 0 ? 700 : 1100, now + i * 0.4);
    }
    osc.start(now);
    osc.stop(now + 24);
    sirenStopRef.current = () => { try { osc.stop(); } catch {} sirenStopRef.current = null; };
  }
  function stopSiren() { sirenStopRef.current?.(); }

  async function start(seat: ZoneId) {
    if (!name.trim()) return;
    setMySeat(seat);
    localStorage.setItem("pitchguard:name", name.trim());

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
            setLink((prev) => ({ ...prev, gps: "ok" }));
          },
          (err) => setLink((prev) => ({ ...prev, gps: "denied", lastErr: `gps: ${err.message}` })),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        );
        watchIdRef.current = id;
      } catch (e: any) {
        setLink((prev) => ({ ...prev, gps: "denied", lastErr: `gps: ${e?.message || e}` }));
      }
    } else {
      setLink((prev) => ({ ...prev, gps: "denied" }));
    }
    setStage("active");
  }

  useEffect(() => () => {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    stopSiren();
  }, []);

  // ─────────────── WELCOME ───────────────
  if (stage === "welcome") {
    const ok = name.trim().length >= 2;
    return (
      <main className="min-h-[100dvh] bg-ink px-5 pt-10 pb-8 flex flex-col">
        <div className="text-center mb-8">
          <div className="text-6xl mb-3">🏟️</div>
          <h1 className="text-3xl font-semibold tracking-tight">Stadium Safety</h1>
          <p className="text-base text-white/60 mt-2">Two quick things and we keep you safe</p>
        </div>

        <label className="block mb-6">
          <div className="text-xs uppercase tracking-[0.18em] text-white/55 mb-2">Step 1 · Your name</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Type your name"
            autoComplete="given-name"
            inputMode="text"
            maxLength={40}
            className="w-full text-lg px-4 py-4 rounded-2xl bg-panel border border-line focus:border-accent outline-none placeholder-white/35"
          />
        </label>

        <div>
          <div className="text-xs uppercase tracking-[0.18em] text-white/55 mb-3">
            Step 2 · Where are you sitting?
          </div>
          <div className="flex flex-col gap-3">
            {(Object.keys(PLACES) as ZoneId[]).map((z) => (
              <button
                key={z}
                onClick={() => start(z)}
                disabled={!ok}
                className="w-full rounded-2xl px-5 py-4 flex items-center gap-4 text-left active:scale-[0.98] transition-transform shadow-lg shadow-black/40 disabled:opacity-30 disabled:active:scale-100"
                style={{ background: PLACES[z].color }}
              >
                <span className="text-4xl leading-none w-10 text-center">{PLACES[z].arrow}</span>
                <div className="flex-1">
                  <div className="text-lg font-semibold text-white">{PLACES[z].nice}</div>
                  <div className="text-xs text-white/85">{PLACES[z].gate}</div>
                </div>
                <span className="text-white/70 text-xl">›</span>
              </button>
            ))}
          </div>
          {!ok && (
            <p className="mt-3 text-xs text-white/45 text-center">Enter your name first to pick a side</p>
          )}
        </div>

        <div className="mt-8 bg-panel/80 border border-line rounded-2xl p-4 text-sm text-white/75 leading-relaxed">
          <p className="font-semibold text-white mb-1">How this works</p>
          <p>We mark your phone on the control room map. If too many people gather near you, your phone will buzz and show which way to walk.</p>
        </div>

        <footer className="mt-auto pt-6 text-center text-xs text-white/35">
          Narendra Modi Stadium
        </footer>
      </main>
    );
  }

  // ─────────────── ACTIVE: MOVE NOW ───────────────
  if (moveNow && target) {
    const arrow = targetZoneId ? PLACES[targetZoneId].arrow : "→";
    const targetColor = targetZoneId ? PLACES[targetZoneId].color : "#22c55e";
    const mapsLink = pos
      ? `https://www.google.com/maps/dir/?api=1&origin=${pos.lat},${pos.lng}&destination=${target.lat},${target.lng}&travelmode=walking`
      : `https://www.google.com/maps/search/?api=1&query=${target.lat},${target.lng}`;

    return (
      <main className="min-h-[100dvh] bg-urgent px-5 py-6 flex flex-col items-center text-center">
        <div className="w-full flex items-center justify-between text-xs uppercase tracking-widest text-white/85">
          <span>{name || "Fan"} · Stadium Safety</span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-white live-dot" /> Live
          </span>
        </div>

        <p className="mt-7 text-sm uppercase tracking-[0.25em] text-white/90">Please move</p>
        <p className="mt-1 text-4xl font-bold">{target.gate}</p>

        <div
          className="my-7 w-44 h-44 rounded-full flex items-center justify-center shadow-2xl shadow-black/50"
          style={{ background: targetColor, boxShadow: `0 18px 60px ${targetColor}66` }}
        >
          <span className="text-[7rem] leading-none text-white drop-shadow">{arrow}</span>
        </div>

        {distance != null && (
          <div className="text-center">
            <p className="text-6xl font-bold num">{Math.round(distance)}<span className="text-2xl font-medium text-white/85"> m</span></p>
            <p className="text-base text-white/85 mt-1">about {minutes} min walk</p>
          </div>
        )}

        <p className="mt-5 text-base text-white/90 max-w-sm leading-snug">{target.why}</p>

        <a
          href={mapsLink}
          target="_blank"
          rel="noreferrer"
          className="mt-7 w-full max-w-sm rounded-2xl bg-white text-black font-semibold text-lg py-5 active:scale-[0.98] transition-transform"
        >
          Open walking directions
        </a>

        <button onClick={stopSiren} className="mt-3 text-sm text-white/70 underline underline-offset-2">
          Quiet the sound
        </button>

        <footer className="mt-auto pt-6 text-[11px] text-white/55">Stay calm. Walk, do not run.</footer>
      </main>
    );
  }

  // ─────────────── ACTIVE: SAFE ───────────────
  return (
    <main className="min-h-[100dvh] bg-ink px-5 py-6 flex flex-col">
      <div className="flex items-center justify-between text-xs uppercase tracking-widest text-white/55">
        <span>{name || "Fan"} · Stadium Safety</span>
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-safe live-dot" /> Watching
        </span>
      </div>

      <div className="mt-6 flex flex-col items-center text-center">
        <div className="w-24 h-24 rounded-full flex items-center justify-center bg-safe/15 border border-safe/40 mb-4">
          <span className="text-5xl">✓</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">You are safe, {name?.split(" ")[0] || "friend"}</h1>
        <p className="text-sm text-white/65 mt-1.5 max-w-xs">Your phone is on the safety map. We will buzz if you need to move.</p>
      </div>

      {/* Your location on a small Google Map */}
      <div className="mt-5">
        <div className="text-[11px] uppercase tracking-[0.18em] text-white/50 mb-2">Your location</div>
        <MyLocationMap pos={pos} name={name || "Me"} seatColor={PLACES[mySeat].color} />
        <div className="text-[11px] text-white/45 mt-1.5 text-center num">
          {pos
            ? `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)} · ±${Math.round(pos.accuracy)} m`
            : "Waiting for GPS…"}
        </div>
      </div>

      <div className="mt-5 bg-panel border border-line rounded-2xl p-4 flex items-center gap-4">
        <span className="text-3xl leading-none w-10 text-center" style={{ color: PLACES[mySeat].color }}>
          {PLACES[mySeat].arrow}
        </span>
        <div className="flex-1">
          <div className="text-xs uppercase text-white/50 tracking-wider">Seat side</div>
          <div className="text-lg font-semibold">{PLACES[mySeat].nice}</div>
          <div className="text-xs text-white/60">{PLACES[mySeat].gate}</div>
        </div>
        <button onClick={() => setStage("welcome")} className="text-xs text-accent underline underline-offset-2">
          Change
        </button>
      </div>

      <details className="mt-4 bg-panel/60 border border-line rounded-xl p-3 text-[11px] text-white/65">
        <summary className="cursor-pointer text-white/70 text-xs">Connection status (tap)</summary>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <StatusChip label="GPS" v={link.gps} />
          <StatusChip label="Phone → Cloud" v={link.write} />
          <StatusChip label="Alerts ← Cloud" v={link.listen} />
        </div>
        {link.lastErr && (
          <div className="mt-2 text-red-300 break-words">⚠ {link.lastErr}</div>
        )}
        <div className="mt-2 text-white/40">FanID: {idRef.current}</div>
      </details>

      <footer className="mt-auto pt-6 text-center text-[11px] text-white/35">
        Narendra Modi Stadium · Live safety
      </footer>
    </main>
  );
}

function MyLocationMap({
  pos,
  name,
  seatColor,
}: {
  pos: { lat: number; lng: number; accuracy: number } | null;
  name: string;
  seatColor: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const meRef = useRef<google.maps.Marker | null>(null);
  const accRef = useRef<google.maps.Circle | null>(null);

  // Init
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !ref.current) return;
    const loader = new Loader({ apiKey: key, version: "weekly" });
    loader.load().then(() => {
      mapRef.current = new google.maps.Map(ref.current!, {
        center: pos ? { lat: pos.lat, lng: pos.lng } : { lat: 23.09225, lng: 72.59720 },
        zoom: 19,
        mapTypeId: "roadmap",
        disableDefaultUI: true,
        gestureHandling: "greedy",
        clickableIcons: false,
        styles: [
          { elementType: "geometry", stylers: [{ color: "#1c1f26" }] },
          { elementType: "labels.text.stroke", stylers: [{ color: "#1c1f26" }] },
          { elementType: "labels.text.fill", stylers: [{ color: "#8a93a4" }] },
          { featureType: "poi", stylers: [{ visibility: "off" }] },
          { featureType: "transit", stylers: [{ visibility: "off" }] },
          { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a2e38" }] },
          { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#8a93a4" }] },
          { featureType: "water", elementType: "geometry", stylers: [{ color: "#0f1115" }] },
        ],
      });
    });
  }, []);

  // Update pin + accuracy ring + recenter
  useEffect(() => {
    if (!mapRef.current || !pos) return;
    const p = { lat: pos.lat, lng: pos.lng };
    const ic = {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 12,
      fillColor: seatColor,
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 3,
    };
    if (meRef.current) {
      meRef.current.setPosition(p);
      meRef.current.setIcon(ic);
      meRef.current.setLabel({ text: name, color: "#fff", fontSize: "11px", fontWeight: "600" });
    } else {
      meRef.current = new google.maps.Marker({
        position: p,
        map: mapRef.current,
        icon: ic,
        label: { text: name, color: "#fff", fontSize: "11px", fontWeight: "600" },
      });
    }
    if (accRef.current) {
      accRef.current.setCenter(p);
      accRef.current.setRadius(Math.max(8, Math.min(120, pos.accuracy)));
    } else {
      accRef.current = new google.maps.Circle({
        map: mapRef.current,
        center: p,
        radius: Math.max(8, Math.min(120, pos.accuracy)),
        fillColor: seatColor,
        fillOpacity: 0.15,
        strokeColor: seatColor,
        strokeOpacity: 0.5,
        strokeWeight: 1,
        clickable: false,
      });
    }
    mapRef.current.panTo(p);
  }, [pos?.lat, pos?.lng, pos?.accuracy, name, seatColor]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return (
      <div className="h-[220px] w-full rounded-2xl bg-panel border border-line flex items-center justify-center text-white/40 text-xs">
        Map key missing
      </div>
    );
  }
  return <div ref={ref} className="h-[220px] w-full rounded-2xl overflow-hidden ring-1 ring-line" />;
}

function StatusChip({ label, v }: { label: string; v: string }) {
  const ok = v === "ok" || v === "live";
  const bad = v === "error" || v === "denied";
  const color = ok ? "#22c55e" : bad ? "#ef4444" : "#a1a1aa";
  return (
    <div className="rounded-md bg-ink/60 border border-line py-1.5">
      <div className="text-[10px] text-white/45">{label}</div>
      <div className="text-xs font-semibold" style={{ color }}>{v}</div>
    </div>
  );
}
