"use client";

import { useEffect, useRef } from "react";
import { Loader } from "@googlemaps/js-api-loader";

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
  zone: string;
  lat: number;
  lng: number;
};

type Reroute = { from?: string | null; to?: string | null } | null;

const STADIUM_CENTER = { lat: 23.09225, lng: 72.59720 };

const ZONE_FALLBACK: Record<string, { lat: number; lng: number; gate: string }> = {
  NORTH: { lat: 23.09365, lng: 72.59710, gate: "Gate 1" },
  EAST:  { lat: 23.09225, lng: 72.59870, gate: "Gate 5" },
  SOUTH: { lat: 23.09075, lng: 72.59720, gate: "Gate 9" },
  WEST:  { lat: 23.09225, lng: 72.59570, gate: "Gate 11" },
};

export default function StadiumMap({
  zones,
  fans,
  reroute,
}: {
  zones: Zone[];
  fans: Fan[];
  reroute: Reroute;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const heatmapRef = useRef<google.maps.visualization.HeatmapLayer | null>(null);
  const fanMarkersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const lineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !ref.current) return;
    const loader = new Loader({
      apiKey: key,
      version: "weekly",
      libraries: ["visualization"],
    });
    loader.load().then(() => {
      mapRef.current = new google.maps.Map(ref.current!, {
        center: STADIUM_CENTER,
        zoom: 17,
        mapTypeId: "hybrid",
        disableDefaultUI: false,
        zoomControl: true,
        mapTypeControl: true,
        gestureHandling: "greedy",
      });

      // Stadium outline
      new google.maps.Rectangle({
        bounds: { north: 23.09310, south: 23.09140, east: 72.59810, west: 72.59630 },
        strokeColor: "#22d3ee",
        strokeOpacity: 0.4,
        strokeWeight: 2,
        fillColor: "#22d3ee",
        fillOpacity: 0.04,
        map: mapRef.current!,
        clickable: false,
      });

      // Gate markers
      Object.entries(ZONE_FALLBACK).forEach(([id, g]) => {
        new google.maps.Marker({
          position: { lat: g.lat, lng: g.lng },
          map: mapRef.current!,
          label: { text: g.gate, color: "#fff", fontSize: "11px", fontWeight: "bold" },
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 7,
            fillColor: "#facc15",
            fillOpacity: 0.95,
            strokeColor: "#000",
            strokeWeight: 1.5,
          },
          title: `${id} · ${g.gate}`,
        });
      });

      // Heatmap layer — populated by the effect below
      heatmapRef.current = new google.maps.visualization.HeatmapLayer({
        map: mapRef.current!,
        radius: 55,
        opacity: 0.78,
        dissipating: true,
        gradient: [
          "rgba(0, 0, 0, 0)",
          "rgba(34, 211, 238, 0.5)",   // cyan (calm)
          "rgba(34, 197, 94, 0.7)",    // green
          "rgba(250, 204, 21, 0.85)",  // yellow
          "rgba(249, 115, 22, 0.9)",   // orange
          "rgba(239, 68, 68, 1)",      // red (danger)
          "rgba(127, 29, 29, 1)",      // dark red (peak)
        ],
      });
    });
  }, []);

  // Rebuild heatmap data whenever fans or zone density changes
  useEffect(() => {
    if (!mapRef.current || !heatmapRef.current) return;
    const points: google.maps.visualization.WeightedLocation[] = [];

    // 1. Each fan = 1 heat point at their real GPS
    fans.forEach((f) => {
      if (typeof f.lat === "number" && typeof f.lng === "number") {
        points.push({
          location: new google.maps.LatLng(f.lat, f.lng),
          weight: 1,
        });
      }
    });

    // 2. Per-zone synthetic crowd points so heatmap reflects total density,
    //    not just the few phones that opted in. Scales with headcount.
    zones.forEach((z) => {
      const fb = ZONE_FALLBACK[z.id];
      const center =
        z.lat != null && z.lng != null
          ? { lat: z.lat, lng: z.lng }
          : fb;
      if (!center) return;

      const n = Math.min(300, Math.round((z.headcount || 0) / 4));
      if (n === 0) return;
      const spreadM = 45; // jitter radius in meters
      const dLat = spreadM / 111000;
      const dLng = spreadM / (111000 * Math.cos((center.lat * Math.PI) / 180));
      const w = Math.max(0.6, Math.min(4, z.density || 0.6));
      for (let i = 0; i < n; i++) {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random());
        points.push({
          location: new google.maps.LatLng(
            center.lat + dLat * r * Math.sin(angle),
            center.lng + dLng * r * Math.cos(angle),
          ),
          weight: w,
        });
      }
    });

    heatmapRef.current.setData(points);
  }, [fans, zones]);

  // Fan dots on top of heatmap so operator can see individuals
  useEffect(() => {
    if (!mapRef.current) return;
    const liveIds = new Set(fans.map((f) => f.id));
    fanMarkersRef.current.forEach((m, id) => {
      if (!liveIds.has(id)) {
        m.setMap(null);
        fanMarkersRef.current.delete(id);
      }
    });
    fans.forEach((f) => {
      const pos = { lat: f.lat, lng: f.lng };
      const icon = {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: "#a78bfa",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
        scale: 7,
      };
      const labelText = (f.name || "Fan").slice(0, 14);
      const label = {
        text: labelText,
        color: "#ffffff",
        fontSize: "11px",
        fontWeight: "600",
        className: "fan-label",
      };
      const m = fanMarkersRef.current.get(f.id);
      if (m) {
        m.setPosition(pos);
        m.setIcon(icon);
        m.setLabel(label);
        m.setTitle(`${f.name} · ${f.zone}`);
      } else {
        const nm = new google.maps.Marker({
          position: pos,
          map: mapRef.current!,
          icon,
          label,
          title: `${f.name} · ${f.zone}`,
          zIndex: 999,
        });
        fanMarkersRef.current.set(f.id, nm);
      }
    });
  }, [fans]);

  // Reroute arrow
  useEffect(() => {
    if (!mapRef.current) return;
    if (lineRef.current) {
      lineRef.current.setMap(null);
      lineRef.current = null;
    }
    if (!reroute?.from || !reroute?.to) return;
    const a = ZONE_FALLBACK[reroute.from];
    const b = ZONE_FALLBACK[reroute.to];
    if (!a || !b) return;
    lineRef.current = new google.maps.Polyline({
      map: mapRef.current,
      path: [{ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng }],
      strokeColor: "#22d3ee",
      strokeOpacity: 1,
      strokeWeight: 5,
      icons: [
        {
          icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 5 },
          offset: "100%",
        },
      ],
    });
  }, [reroute?.from, reroute?.to]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return (
      <div className="h-[420px] flex items-center justify-center text-gray-500 border border-dashed border-gray-700 rounded">
        Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to enable the map view.
      </div>
    );
  }
  return (
    <div className="relative">
      <div ref={ref} className="h-[360px] w-full rounded-xl overflow-hidden ring-1 ring-line" />
      <div className="absolute bottom-3 left-3 backdrop-blur-md bg-black/55 text-[10px] text-white/85 px-3 py-1.5 rounded-full flex items-center gap-2 border border-white/10">
        <span className="text-white/55">Crowd</span>
        <span className="inline-block w-2 h-2 rounded-full bg-cyan-400" />
        <span>calm</span>
        <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />
        <span>busy</span>
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
        <span>danger</span>
        <span className="mx-1 h-3 w-px bg-white/15" />
        <span className="inline-block w-2 h-2 rounded-full bg-violet-400 ring-1 ring-white" />
        <span>phone</span>
      </div>
    </div>
  );
}
