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

// Narendra Modi Stadium, Ahmedabad
const STADIUM_CENTER = { lat: 23.09225, lng: 72.59720 };

// Gate fallback positions if Firestore zone doc lacks coords
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
  const zoneMarkersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const fanMarkersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const lineRef = useRef<google.maps.Polyline | null>(null);

  // Initialize map once
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !ref.current) return;
    const loader = new Loader({ apiKey: key, version: "weekly" });
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

      // Stadium outline (rough rectangle around the building)
      new google.maps.Rectangle({
        bounds: {
          north: 23.09310,
          south: 23.09140,
          east: 72.59810,
          west: 72.59630,
        },
        strokeColor: "#22d3ee",
        strokeOpacity: 0.4,
        strokeWeight: 2,
        fillColor: "#22d3ee",
        fillOpacity: 0.06,
        map: mapRef.current!,
        clickable: false,
      });

      // Always-present gate markers
      Object.entries(ZONE_FALLBACK).forEach(([id, g]) => {
        const m = new google.maps.Marker({
          position: { lat: g.lat, lng: g.lng },
          map: mapRef.current!,
          label: { text: g.gate, color: "#fff", fontSize: "10px", fontWeight: "bold" },
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 6,
            fillColor: "#22d3ee",
            fillOpacity: 0.85,
            strokeColor: "#fff",
            strokeWeight: 1.5,
          },
          title: `${id} · ${g.gate}`,
        });
        zoneMarkersRef.current.set(`gate:${id}`, m);
      });
    });
  }, []);

  // Update zone density bubbles
  useEffect(() => {
    if (!mapRef.current) return;
    zones.forEach((z) => {
      const fb = ZONE_FALLBACK[z.id];
      const pos = z.lat != null && z.lng != null ? { lat: z.lat, lng: z.lng } : fb;
      if (!pos) return;
      const color = z.density >= 4 ? "#ef4444" : z.density >= 3 ? "#f59e0b" : "#22d3ee";
      const scale = Math.min(38, 14 + (z.headcount || 0) / 30);
      const icon = {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: color,
        fillOpacity: 0.5,
        strokeWeight: 2,
        strokeColor: color,
        scale,
      };
      const existing = zoneMarkersRef.current.get(`zone:${z.id}`);
      if (existing) {
        existing.setIcon(icon);
        existing.setPosition(pos);
      } else {
        const nm = new google.maps.Marker({
          position: pos,
          map: mapRef.current!,
          label: { text: `${z.id}\n${z.density?.toFixed(1)}/m²`, color: "#fff", fontSize: "10px", fontWeight: "bold" },
          icon,
        });
        zoneMarkersRef.current.set(`zone:${z.id}`, nm);
      }
    });
  }, [zones]);

  // Update fan dots
  useEffect(() => {
    if (!mapRef.current) return;
    const liveIds = new Set(fans.map((f) => f.id));
    // remove stale
    fanMarkersRef.current.forEach((m, id) => {
      if (!liveIds.has(id)) {
        m.setMap(null);
        fanMarkersRef.current.delete(id);
      }
    });
    // add/update
    fans.forEach((f) => {
      const pos = { lat: f.lat, lng: f.lng };
      const m = fanMarkersRef.current.get(f.id);
      const icon = {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: "#a78bfa",
        fillOpacity: 0.9,
        strokeColor: "#fff",
        strokeWeight: 2,
        scale: 6,
      };
      if (m) {
        m.setPosition(pos);
        m.setIcon(icon);
      } else {
        const nm = new google.maps.Marker({
          position: pos,
          map: mapRef.current!,
          icon,
          title: `${f.name} · ${f.zone}`,
        });
        fanMarkersRef.current.set(f.id, nm);
      }
    });
  }, [fans]);

  // Reroute arrow polyline
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
      strokeWeight: 4,
      icons: [
        {
          icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 4 },
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
  return <div ref={ref} className="h-[420px] w-full rounded-lg overflow-hidden" />;
}
