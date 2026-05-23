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

type Reroute = { from?: string | null; to?: string | null } | null;

const STADIUM_CENTER = { lat: 12.97920, lng: 77.59960 };

// Fallback if Firestore zone docs don't yet carry coords.
const ZONE_FALLBACK: Record<string, google.maps.LatLngLiteral> = {
  NORTH: { lat: 12.97955, lng: 77.59960 },
  EAST:  { lat: 12.97890, lng: 77.60040 },
  WEST:  { lat: 12.97890, lng: 77.59880 },
};

export default function StadiumMap({
  zones,
  reroute,
}: {
  zones: Zone[];
  reroute: Reroute;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const lineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (!key || !ref.current) return;
    const loader = new Loader({ apiKey: key, version: "weekly" });
    loader.load().then(() => {
      mapRef.current = new google.maps.Map(ref.current!, {
        center: STADIUM_CENTER,
        zoom: 18,
        mapTypeId: "satellite",
        disableDefaultUI: true,
      });
    });
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;
    zones.forEach((z) => {
      const pos =
        z.lat != null && z.lng != null
          ? { lat: z.lat, lng: z.lng }
          : ZONE_FALLBACK[z.id];
      if (!pos) return;
      const color = z.density >= 4 ? "#ef4444" : z.density >= 3 ? "#f59e0b" : "#22d3ee";
      const m = markersRef.current.get(z.id);
      const icon = {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: color,
        fillOpacity: 0.7,
        strokeWeight: 2,
        strokeColor: "#fff",
        scale: Math.min(40, 12 + (z.headcount || 0) / 25),
      };
      if (m) {
        m.setIcon(icon);
        m.setPosition(pos);
      } else {
        const nm = new google.maps.Marker({
          position: pos,
          map: mapRef.current!,
          label: { text: z.label || z.id, color: "#fff", fontSize: "11px" },
          icon,
        });
        markersRef.current.set(z.id, nm);
      }
    });
  }, [zones]);

  // Draw reroute arrow when brain calls one
  useEffect(() => {
    if (!mapRef.current) return;
    if (lineRef.current) {
      lineRef.current.setMap(null);
      lineRef.current = null;
    }
    if (!reroute?.from || !reroute?.to) return;
    const a =
      zones.find((z) => z.id === reroute.from) ||
      ({ lat: ZONE_FALLBACK[reroute.from]?.lat, lng: ZONE_FALLBACK[reroute.from]?.lng } as Zone);
    const b =
      zones.find((z) => z.id === reroute.to) ||
      ({ lat: ZONE_FALLBACK[reroute.to]?.lat, lng: ZONE_FALLBACK[reroute.to]?.lng } as Zone);
    if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return;
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
  }, [reroute, zones]);

  if (!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) {
    return (
      <div className="h-[380px] flex items-center justify-center text-gray-500 border border-dashed border-gray-700 rounded">
        Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY to enable the map view.
      </div>
    );
  }
  return <div ref={ref} className="h-[380px] w-full rounded-lg overflow-hidden" />;
}
