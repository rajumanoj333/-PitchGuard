"use client";

/**
 * Fan beacon page. iPhone Safari friendly. PWA-ish.
 *
 * Flow:
 *   1. User taps "Arm beacon" — grants geolocation + unlocks WebAudio.
 *   2. Continuous geolocation watch keeps last GPS fix.
 *   3. Firestore live/current doc updates on every brain tick.
 *   4. If alarm=true, screen flashes red, siren loops, route panel shows
 *      distance + bearing from current GPS to safe gate, deep link to Maps.
 */

import { useEffect, useRef, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";

type Live = {
  severity?: "info" | "watch" | "warn" | "critical";
  summary?: string;
  actions?: string[];
  affected_zones?: string[];
  reroute_from_zone?: string | null;
  reroute_to_zone?: string | null;
  reroute_to_gate?: string | null;
  reroute_to_lat?: number | null;
  reroute_to_lng?: number | null;
  alarm?: boolean;
};

type Geo = { lat: number; lng: number; accuracy: number } | null;

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearingDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const toDeg = (x: number) => (x * 180) / Math.PI;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function compass(deg: number) {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

export default function FanPage() {
  const [armed, setArmed] = useState(false);
  const [zoneId, setZoneId] = useState<string>("NORTH");
  const [geo, setGeo] = useState<Geo>(null);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sirenStopRef = useRef<(() => void) | null>(null);
  const watchIdRef = useRef<number | null>(null);

  // Subscribe to brain's live decision regardless of arm state (so we have data ready).
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "live", "current"), (snap) => {
      const d = snap.data() as Live | undefined;
      if (d) setLive(d);
    });
    return () => unsub();
  }, []);

  // Trigger / stop siren when alarm flips
  useEffect(() => {
    if (!armed) return;
    const myZone = zoneId;
    const isMine =
      live?.alarm &&
      (live.affected_zones || []).length > 0 &&
      (live.affected_zones || []).includes(myZone);
    if (isMine) {
      startSiren();
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 800]);
    } else {
      stopSiren();
    }
    return () => stopSiren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live?.alarm, live?.affected_zones, armed, zoneId]);

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
    // Two-tone alternating siren: 700 ↔ 1100 Hz every 0.4s, looping for 30s
    for (let i = 0; i < 75; i++) {
      const t = now + i * 0.4;
      osc.frequency.setValueAtTime(i % 2 === 0 ? 700 : 1100, t);
    }
    osc.start(now);
    osc.stop(now + 30);
    sirenStopRef.current = () => {
      try { osc.stop(); } catch {}
      try { gain.disconnect(); } catch {}
      sirenStopRef.current = null;
    };
  }

  function stopSiren() {
    sirenStopRef.current?.();
  }

  async function arm() {
    // 1. Unlock WebAudio (must be inside a user gesture on iOS)
    try {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new Ctor();
      await ctx.resume();
      // play one silent buffer so iOS marks context as user-activated
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      audioCtxRef.current = ctx;
    } catch (e) {
      console.warn("audio init failed", e);
    }

    // 2. Geolocation watch
    if (!("geolocation" in navigator)) {
      setGeoErr("Geolocation unsupported on this browser");
    } else {
      try {
        const id = navigator.geolocation.watchPosition(
          (pos) => {
            setGeo({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            });
            setGeoErr(null);
          },
          (err) => setGeoErr(err.message),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
        );
        watchIdRef.current = id;
      } catch (e: any) {
        setGeoErr(e?.message || "geolocation error");
      }
    }

    setArmed(true);
  }

  useEffect(() => () => {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    stopSiren();
  }, []);

  const target =
    live?.reroute_to_lat != null && live?.reroute_to_lng != null
      ? { lat: live.reroute_to_lat, lng: live.reroute_to_lng }
      : null;

  const distance = geo && target ? haversineMeters(geo, target) : null;
  const heading = geo && target ? bearingDeg(geo, target) : null;
  const mapsLink =
    target && geo
      ? `https://www.google.com/maps/dir/?api=1&origin=${geo.lat},${geo.lng}&destination=${target.lat},${target.lng}&travelmode=walking`
      : target
      ? `https://www.google.com/maps/search/?api=1&query=${target.lat},${target.lng}`
      : null;

  const isAlerting =
    armed &&
    live?.alarm &&
    (live.affected_zones || []).includes(zoneId);

  return (
    <main
      className={`min-h-screen p-5 flex flex-col gap-4 transition-colors duration-150 ${
        isAlerting ? "bg-crit animate-pulse" : "bg-ink"
      }`}
    >
      <header className="flex items-center justify-between">
        <div className="text-lg font-bold tracking-wide">
          PITCHGUARD <span className="text-accent">·</span> Fan Beacon
        </div>
        <span
          className={`text-xs px-2 py-1 rounded ${
            armed ? "bg-accent text-ink" : "bg-gray-700 text-gray-300"
          }`}
        >
          {armed ? "ARMED" : "OFF"}
        </span>
      </header>

      {!armed ? (
        <section className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="text-center max-w-sm">
            <p className="text-2xl font-bold mb-2">Welcome to the stadium</p>
            <p className="text-gray-400 text-sm">
              Arm the beacon to receive safety reroutes during the match. We use your live
              location to guide you to the safest exit if a surge is detected.
            </p>
          </div>

          <label className="text-sm text-gray-400 flex flex-col items-center gap-2">
            Your section
            <select
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value)}
              className="bg-panel text-white text-lg px-4 py-2 rounded border border-gray-700"
            >
              <option value="NORTH">Zone North</option>
              <option value="EAST">Zone East</option>
              <option value="WEST">Zone West</option>
            </select>
          </label>

          <button
            onClick={arm}
            className="bg-accent text-ink font-bold text-lg px-8 py-4 rounded-xl shadow-lg active:scale-95"
          >
            🛡  Arm Beacon
          </button>
          <p className="text-xs text-gray-500 max-w-xs text-center">
            Allow location + sound when prompted. Required for safety alerts.
          </p>
        </section>
      ) : (
        <section className="flex flex-col gap-4 flex-1">
          <div className="bg-panel rounded-xl p-4">
            <p className="text-xs text-gray-400 uppercase mb-1">Your zone</p>
            <p className="text-2xl font-bold">{zoneId}</p>
            {geo ? (
              <p className="text-xs text-gray-500 mt-1">
                GPS {geo.lat.toFixed(5)}, {geo.lng.toFixed(5)} (±{geo.accuracy.toFixed(0)} m)
              </p>
            ) : (
              <p className="text-xs text-warn mt-1">{geoErr || "Acquiring GPS…"}</p>
            )}
          </div>

          {isAlerting ? (
            <div className="bg-black/70 border-4 border-white rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-4xl">🚨</span>
                <div>
                  <p className="uppercase text-sm tracking-widest">Evacuate to</p>
                  <p className="text-3xl font-black">
                    Zone {live?.reroute_to_zone} · Gate {live?.reroute_to_gate}
                  </p>
                </div>
              </div>

              {distance != null && heading != null ? (
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div className="bg-white/10 rounded-lg py-3">
                    <p className="text-xs uppercase text-white/70">Distance</p>
                    <p className="text-2xl font-bold">{Math.round(distance)} m</p>
                  </div>
                  <div className="bg-white/10 rounded-lg py-3">
                    <p className="text-xs uppercase text-white/70">Heading</p>
                    <p className="text-2xl font-bold">
                      {compass(heading)} <span className="text-base">{Math.round(heading)}°</span>
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm">Waiting for GPS fix…</p>
              )}

              <p className="text-sm leading-snug">{live?.summary}</p>

              <ul className="text-sm space-y-1 list-disc list-inside">
                {live?.actions?.slice(0, 3).map((a, i) => <li key={i}>{a}</li>)}
              </ul>

              {mapsLink && (
                <a
                  href={mapsLink}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-center bg-white text-crit font-bold py-3 rounded-lg text-lg active:scale-95"
                >
                  Open turn-by-turn in Maps
                </a>
              )}

              <button
                onClick={stopSiren}
                className="block w-full text-center text-xs text-white/70 underline"
              >
                Silence siren (route stays active)
              </button>
            </div>
          ) : (
            <div className="bg-panel rounded-xl p-5 flex-1 flex flex-col justify-center items-center text-center">
              <p className="text-4xl mb-3">{live?.severity === "warn" ? "⚠️" : "✅"}</p>
              <p className="text-lg font-semibold">
                {live?.severity === "warn"
                  ? "Heightened watch in your zone"
                  : "Zone clear — enjoy the match"}
              </p>
              <p className="text-sm text-gray-400 mt-2 max-w-xs">
                {live?.summary || "Listening for safety updates…"}
              </p>
            </div>
          )}
        </section>
      )}

      <footer className="text-center text-[10px] text-gray-600">
        Powered by Gemini 2.5 Flash · Vertex AI · Firestore live
      </footer>
    </main>
  );
}
