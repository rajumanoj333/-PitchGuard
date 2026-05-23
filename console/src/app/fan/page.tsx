"use client";

/**
 * Fan beacon page — iPhone-optimized.
 *
 * Flow:
 *   1. Pick name + entry zone.
 *   2. Arm beacon — grants Geolocation + unlocks WebAudio.
 *   3. App writes our position to Firestore `fans/{fanId}` every 5s so operator sees us.
 *   4. App listens to:
 *        - `live/current` (brain's latest decision)
 *        - `alerts` collection (operator-pushed alerts targeted to my zone)
 *      If alarm matches our zone → siren + embedded Google walking-map to safe gate.
 *   5. Demo controls: "Jump to Zone X" buttons fake our GPS to a zone center.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  doc, onSnapshot, setDoc, deleteDoc,
  collection, query, where, orderBy, limit, serverTimestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { Loader } from "@googlemaps/js-api-loader";

type ZoneId = "NORTH" | "EAST" | "SOUTH" | "WEST";

const STADIUM_CENTER = { lat: 23.09225, lng: 72.59720 };

// Real Narendra Modi Stadium gate coords. Used both for the zone selector and demo jumps.
const ZONES: Record<ZoneId, { gate: string; lat: number; lng: number; label: string }> = {
  NORTH: { gate: "Gate 1",  lat: 23.09365, lng: 72.59710, label: "Zone North · Gate 1 (Motera Rd)" },
  EAST:  { gate: "Gate 5",  lat: 23.09225, lng: 72.59870, label: "Zone East · Gate 5 (Players Pavilion)" },
  SOUTH: { gate: "Gate 9",  lat: 23.09075, lng: 72.59720, label: "Zone South · Gate 9 (Main Entrance)" },
  WEST:  { gate: "Gate 11", lat: 23.09225, lng: 72.59570, label: "Zone West · Gate 11 (Broadcast Side)" },
};

type Geo = { lat: number; lng: number; accuracy: number } | null;

type Decision = {
  severity?: "info" | "watch" | "warn" | "critical";
  summary?: string;
  actions?: string[];
  affected_zones?: string[];
  reroute_to_zone?: string | null;
  reroute_to_gate?: string | null;
  reroute_to_lat?: number | null;
  reroute_to_lng?: number | null;
  alarm?: boolean;
};

type Alert = {
  id: string;
  zone_id: string;
  exit_gate: string;
  exit_lat: number;
  exit_lng: number;
  message: string;
  severity?: string;
  ts?: { seconds: number } | null;
};

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function getOrMintFanId(): string {
  const k = "pitchguard:fanId";
  let id = typeof window !== "undefined" ? localStorage.getItem(k) : null;
  if (!id) {
    id = "fan_" + Math.random().toString(36).slice(2, 11);
    if (typeof window !== "undefined") localStorage.setItem(k, id);
  }
  return id;
}

export default function FanPage() {
  const [armed, setArmed] = useState(false);
  const [name, setName] = useState("");
  const [zoneId, setZoneId] = useState<ZoneId>("NORTH");
  const [realGeo, setRealGeo] = useState<Geo>(null);
  const [demoOverride, setDemoOverride] = useState<{ zone: ZoneId; lat: number; lng: number } | null>(null);
  const [geoErr, setGeoErr] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [latestAlert, setLatestAlert] = useState<Alert | null>(null);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sirenStopRef = useRef<(() => void) | null>(null);
  const watchIdRef = useRef<number | null>(null);
  const fanIdRef = useRef<string>("");

  // Effective position: demo override beats real GPS.
  const pos = demoOverride
    ? { lat: demoOverride.lat, lng: demoOverride.lng, accuracy: 5 }
    : realGeo;

  // Effective zone: demo override beats user-selected zone.
  const myZone: ZoneId = (demoOverride?.zone ?? zoneId) as ZoneId;

  useEffect(() => { fanIdRef.current = getOrMintFanId(); }, []);

  // --- Firestore subscriptions ---
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "live", "current"), (snap) => {
      const d = snap.data() as Decision | undefined;
      if (d) setDecision(d);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!armed) return;
    const q = query(
      collection(db, "alerts"),
      where("zone_id", "==", myZone),
      orderBy("ts", "desc"),
      limit(1),
    );
    const unsub = onSnapshot(q, (snap) => {
      const d = snap.docs[0];
      if (!d) return setLatestAlert(null);
      setLatestAlert({ id: d.id, ...(d.data() as Omit<Alert, "id">) });
    });
    return () => unsub();
  }, [armed, myZone]);

  // --- Write fan heartbeat to Firestore ---
  useEffect(() => {
    if (!armed || !pos) return;
    const fanId = fanIdRef.current;
    const tick = async () => {
      try {
        await setDoc(doc(db, "fans", fanId), {
          name: name || "Anon Fan",
          zone: myZone,
          lat: pos.lat,
          lng: pos.lng,
          accuracy: Math.min(999, Math.round(pos.accuracy)),
          ts: serverTimestamp(),
          ua: navigator.userAgent.slice(0, 80),
        });
      } catch (e) {
        console.warn("fan heartbeat failed", e);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [armed, pos?.lat, pos?.lng, name, myZone]);

  // Clean up own doc on unload
  useEffect(() => {
    if (!armed) return;
    const fanId = fanIdRef.current;
    const handler = () => deleteDoc(doc(db, "fans", fanId)).catch(() => {});
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [armed]);

  // --- Alarm logic ---
  const brainAlarmForMe =
    !!decision?.alarm &&
    (decision.affected_zones || []).includes(myZone);
  const isAlerting = armed && (brainAlarmForMe || !!latestAlert);

  useEffect(() => {
    if (isAlerting) {
      startSiren();
      if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 800, 200, 400]);
    } else {
      stopSiren();
    }
    return () => stopSiren();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAlerting]);

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
  function stopSiren() { sirenStopRef.current?.(); }

  // --- Arm: unlock audio + start GPS ---
  async function arm() {
    try {
      const Ctor = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
      const ctx = new Ctor();
      await ctx.resume();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start(0);
      audioCtxRef.current = ctx;
    } catch (e) { console.warn("audio init failed", e); }

    if (!("geolocation" in navigator)) {
      setGeoErr("Geolocation unsupported on this browser");
    } else {
      try {
        const id = navigator.geolocation.watchPosition(
          (p) => {
            setRealGeo({
              lat: p.coords.latitude,
              lng: p.coords.longitude,
              accuracy: p.coords.accuracy,
            });
            setGeoErr(null);
          },
          (err) => setGeoErr(err.message),
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        );
        watchIdRef.current = id;
      } catch (e: any) { setGeoErr(e?.message || "geolocation error"); }
    }
    setArmed(true);
  }

  useEffect(() => () => {
    if (watchIdRef.current != null) navigator.geolocation.clearWatch(watchIdRef.current);
    stopSiren();
  }, []);

  // --- Active exit route ---
  const exit = latestAlert
    ? {
        gate: latestAlert.exit_gate,
        lat: latestAlert.exit_lat,
        lng: latestAlert.exit_lng,
        message: latestAlert.message,
        source: "operator" as const,
      }
    : decision?.alarm && decision.reroute_to_lat && decision.reroute_to_lng
    ? {
        gate: decision.reroute_to_gate || "",
        lat: decision.reroute_to_lat,
        lng: decision.reroute_to_lng,
        message: decision.summary || "",
        source: "brain" as const,
      }
    : null;

  const distance = pos && exit ? haversineMeters(pos, exit) : null;

  return (
    <main
      className={`min-h-screen p-4 flex flex-col gap-4 transition-colors duration-150 ${
        isAlerting ? "bg-crit animate-pulse" : "bg-ink"
      }`}
    >
      <header className="flex items-center justify-between">
        <div className="text-base font-bold tracking-wide">
          PITCHGUARD <span className="text-accent">·</span> Fan
        </div>
        <span className={`text-[10px] px-2 py-1 rounded ${armed ? "bg-accent text-ink" : "bg-gray-700 text-gray-300"}`}>
          {armed ? "ARMED" : "OFF"}
        </span>
      </header>

      {!armed ? (
        <section className="flex-1 flex flex-col items-center justify-center gap-5">
          <div className="text-center max-w-sm">
            <p className="text-2xl font-bold mb-1">Welcome to the stadium</p>
            <p className="text-gray-400 text-sm">
              Arm to receive safety reroutes during the match. Uses live GPS to guide you to
              the safest exit when a surge is detected.
            </p>
          </div>

          <label className="text-sm text-gray-400 flex flex-col items-center gap-2 w-full max-w-xs">
            Your name (optional)
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Raju"
              className="bg-panel text-white text-base px-3 py-2 rounded border border-gray-700 w-full"
            />
          </label>

          <label className="text-sm text-gray-400 flex flex-col items-center gap-2 w-full max-w-xs">
            Your section
            <select
              value={zoneId}
              onChange={(e) => setZoneId(e.target.value as ZoneId)}
              className="bg-panel text-white text-base px-3 py-2 rounded border border-gray-700 w-full"
            >
              {(Object.keys(ZONES) as ZoneId[]).map((z) => (
                <option key={z} value={z}>{ZONES[z].label}</option>
              ))}
            </select>
          </label>

          <button
            onClick={arm}
            className="bg-accent text-ink font-bold text-lg px-8 py-4 rounded-xl shadow-lg active:scale-95"
          >
            🛡  Arm Beacon
          </button>
          <p className="text-[11px] text-gray-500 max-w-xs text-center">
            Allow Location + Sound when prompted. Required for safety alerts.
          </p>
        </section>
      ) : (
        <section className="flex flex-col gap-3 flex-1">
          <div className="bg-panel rounded-xl p-3 flex items-center justify-between">
            <div>
              <p className="text-[10px] text-gray-400 uppercase">Your zone</p>
              <p className="text-lg font-bold">
                {myZone}
                {demoOverride && <span className="ml-2 text-xs text-warn">(demo)</span>}
              </p>
              <p className="text-[10px] text-gray-500">{ZONES[myZone].label}</p>
            </div>
            <div className="text-right">
              <p className="text-[10px] text-gray-400 uppercase">Position</p>
              {pos ? (
                <p className="text-[10px] text-gray-300">
                  {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
                  <br />±{pos.accuracy.toFixed(0)}m
                </p>
              ) : (
                <p className="text-[11px] text-warn">{geoErr || "Acquiring GPS…"}</p>
              )}
            </div>
          </div>

          {/* Always-visible mini map showing where you are + your assigned exit */}
          <MiniMap pos={pos} myZone={myZone} alerting={isAlerting} exit={exit} />

          {isAlerting && exit ? (
            <div className="bg-black/80 border-4 border-white rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-4xl">🚨</span>
                <div>
                  <p className="uppercase text-[11px] tracking-widest">Evacuate to</p>
                  <p className="text-2xl font-black">{exit.gate}</p>
                </div>
              </div>
              {distance != null && (
                <div className="bg-white/10 rounded-lg py-3 text-center">
                  <p className="text-[10px] uppercase text-white/70">Distance to exit</p>
                  <p className="text-3xl font-bold">{Math.round(distance)} m</p>
                </div>
              )}
              <p className="text-sm leading-snug">{exit.message}</p>
              {pos && (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&origin=${pos.lat},${pos.lng}&destination=${exit.lat},${exit.lng}&travelmode=walking`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-center bg-white text-crit font-bold py-3 rounded-lg text-base active:scale-95"
                >
                  Open turn-by-turn in Maps
                </a>
              )}
              <button
                onClick={stopSiren}
                className="block w-full text-center text-[11px] text-white/70 underline"
              >
                Silence siren (route stays active)
              </button>
              <p className="text-[10px] text-white/60 text-right">via {exit.source}</p>
            </div>
          ) : (
            <div className="bg-panel rounded-xl p-4 text-center">
              <p className="text-2xl mb-1">{decision?.severity === "warn" ? "⚠️" : "✅"}</p>
              <p className="text-sm font-semibold">
                {decision?.severity === "warn" ? "Heightened watch" : "All clear in your zone"}
              </p>
              <p className="text-[11px] text-gray-400 mt-1">
                {decision?.summary || "Listening for safety updates…"}
              </p>
            </div>
          )}

          {/* Demo controls — jump between zones to fake movement */}
          <div className="bg-panel/60 border border-gray-700 rounded-xl p-3">
            <p className="text-[10px] uppercase text-gray-400 mb-2">Demo · jump position</p>
            <div className="grid grid-cols-4 gap-2">
              {(Object.keys(ZONES) as ZoneId[]).map((z) => (
                <button
                  key={z}
                  onClick={() => setDemoOverride({ zone: z, lat: ZONES[z].lat, lng: ZONES[z].lng })}
                  className={`text-xs py-2 rounded ${
                    demoOverride?.zone === z
                      ? "bg-accent text-ink font-bold"
                      : "bg-gray-700 text-gray-200"
                  }`}
                >
                  {z}
                </button>
              ))}
            </div>
            {demoOverride && (
              <button
                onClick={() => setDemoOverride(null)}
                className="mt-2 w-full text-[10px] text-gray-400 underline"
              >
                Resume real GPS
              </button>
            )}
          </div>
        </section>
      )}

      <footer className="text-center text-[10px] text-gray-600">
        Narendra Modi Stadium · Gemini 2.5 Flash · Firestore live
      </footer>
    </main>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// MiniMap: embedded Google Map showing the fan dot + (when alerting) walking
// directions polyline to the assigned exit gate.
// ───────────────────────────────────────────────────────────────────────────
function MiniMap({
  pos,
  myZone,
  alerting,
  exit,
}: {
  pos: Geo;
  myZone: ZoneId;
  alerting: boolean;
  exit: { lat: number; lng: number; gate: string } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const fanMarkerRef = useRef<google.maps.Marker | null>(null);
  const gateMarkersRef = useRef<google.maps.Marker[]>([]);
  const dirRendererRef = useRef<google.maps.DirectionsRenderer | null>(null);
  const dirSvcRef = useRef<google.maps.DirectionsService | null>(null);
  const lastRouteKey = useRef<string>("");

  // Init map once
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !ref.current) return;
    const loader = new Loader({ apiKey: key, version: "weekly", libraries: ["routes"] });
    loader.load().then(() => {
      mapRef.current = new google.maps.Map(ref.current!, {
        center: STADIUM_CENTER,
        zoom: 17,
        mapTypeId: "hybrid",
        disableDefaultUI: true,
        gestureHandling: "greedy",
      });
      // Drop gate markers once
      (Object.keys(ZONES) as ZoneId[]).forEach((z) => {
        const m = new google.maps.Marker({
          position: { lat: ZONES[z].lat, lng: ZONES[z].lng },
          map: mapRef.current!,
          label: { text: ZONES[z].gate, color: "#fff", fontSize: "10px", fontWeight: "bold" },
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 5,
            fillColor: "#22d3ee",
            fillOpacity: 0.9,
            strokeColor: "#fff",
            strokeWeight: 1,
          },
        });
        gateMarkersRef.current.push(m);
      });
      dirSvcRef.current = new google.maps.DirectionsService();
      dirRendererRef.current = new google.maps.DirectionsRenderer({
        map: mapRef.current!,
        suppressMarkers: true,
        polylineOptions: { strokeColor: "#22d3ee", strokeWeight: 6, strokeOpacity: 0.95 },
      });
    });
  }, []);

  // Update fan dot position
  useEffect(() => {
    if (!mapRef.current || !pos) return;
    const p = { lat: pos.lat, lng: pos.lng };
    if (!fanMarkerRef.current) {
      fanMarkerRef.current = new google.maps.Marker({
        position: p,
        map: mapRef.current,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: alerting ? "#ef4444" : "#22d3ee",
          fillOpacity: 0.95,
          strokeColor: "#fff",
          strokeWeight: 3,
        },
        label: { text: "You", color: "#fff", fontSize: "10px", fontWeight: "bold" },
      });
    } else {
      fanMarkerRef.current.setPosition(p);
      fanMarkerRef.current.setIcon({
        path: google.maps.SymbolPath.CIRCLE,
        scale: 10,
        fillColor: alerting ? "#ef4444" : "#22d3ee",
        fillOpacity: 0.95,
        strokeColor: "#fff",
        strokeWeight: 3,
      });
    }
  }, [pos?.lat, pos?.lng, alerting]);

  // Draw walking route only when alerting + we have both endpoints
  useEffect(() => {
    if (!mapRef.current || !dirSvcRef.current || !dirRendererRef.current) return;
    if (!alerting || !pos || !exit) {
      dirRendererRef.current.set("directions", null);
      lastRouteKey.current = "";
      return;
    }
    const key = `${pos.lat.toFixed(4)},${pos.lng.toFixed(4)}|${exit.lat},${exit.lng}`;
    if (key === lastRouteKey.current) return;
    lastRouteKey.current = key;
    dirSvcRef.current.route(
      {
        origin: { lat: pos.lat, lng: pos.lng },
        destination: { lat: exit.lat, lng: exit.lng },
        travelMode: google.maps.TravelMode.WALKING,
      },
      (res, status) => {
        if (status === "OK" && res) dirRendererRef.current!.setDirections(res);
      },
    );
    // Fit bounds to both
    const bounds = new google.maps.LatLngBounds();
    bounds.extend({ lat: pos.lat, lng: pos.lng });
    bounds.extend({ lat: exit.lat, lng: exit.lng });
    mapRef.current.fitBounds(bounds, { top: 60, right: 40, bottom: 60, left: 40 });
  }, [alerting, pos?.lat, pos?.lng, exit?.lat, exit?.lng]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return (
      <div className="h-[260px] flex items-center justify-center text-gray-500 text-xs border border-dashed border-gray-700 rounded">
        Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
      </div>
    );
  }
  return <div ref={ref} className="h-[260px] w-full rounded-xl overflow-hidden" />;
}
