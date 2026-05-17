"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import Sidebar from "./Sidebar";
import RiskPopup from "./RiskPopup";
import WarmingPanel from "./WarmingPanel";

// ── Types ──────────────────────────────────────────────────────────────────
export interface Airport {
  code: string;
  name: string;
  lat: number;
  lon: number;
}

export interface ContrailFeature {
  // Core schema from predict_local.py / predict Lambda
  intensity?: number;          // 0.5 = short-lived, 1.0 = persistent
  label?: string;              // "short" | "persistent"
  // Enriched schema added by predict Lambda (and used in demo data)
  risk_level?: "low" | "medium" | "high";
  risk_score?: number;
  altitude_ft?: number;
  temperature_k?: number;
  rhi?: number;
  area_km2?: number;
  valid_time?: string;
}

/** Normalise either schema into a unified risk score 0→1. */
export function featureRiskScore(f: ContrailFeature): number {
  if (f.risk_score !== undefined) return f.risk_score;
  if (f.intensity   !== undefined) return f.intensity;   // 0.5 or 1.0
  return 0;
}

export interface AircraftType {
  id: string;
  label: string;
  wingspan_m: number;
  cruise_alt_ft: number;
  fuel_burn_kg_per_km: number;
  rf_factor: number; // radiative forcing multiplier vs baseline
}

export const AIRCRAFT_TYPES: AircraftType[] = [
  {
    id: "regional",
    label: "Regional Jet (e.g. CRJ-700)",
    wingspan_m: 23.2,
    cruise_alt_ft: 31000,
    fuel_burn_kg_per_km: 2.8,
    rf_factor: 0.72,
  },
  {
    id: "narrowbody",
    label: "Narrow-body (e.g. 737 MAX)",
    wingspan_m: 35.9,
    cruise_alt_ft: 35000,
    fuel_burn_kg_per_km: 5.1,
    rf_factor: 1.0,
  },
  {
    id: "widebody",
    label: "Wide-body (e.g. 787-9)",
    wingspan_m: 60.1,
    cruise_alt_ft: 38000,
    fuel_burn_kg_per_km: 8.6,
    rf_factor: 1.41,
  },
];

// ── Rainbow colour scale (blue → cyan → green → yellow → orange → red) ───
// Maps a risk_score in [0, 1] to an HSL hue: 240 (blue) → 0 (red).
export function riskScoreToHex(score: number): string {
  const s = Math.max(0, Math.min(1, score));
  const hue = Math.round((1 - s) * 240); // 240 = blue, 0 = red
  // Increase saturation and lightness slightly toward red for vibrancy
  const sat = 85 + Math.round(s * 10);
  const lit = 52 + Math.round((1 - s) * 10);
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

function riskStyle(score: number) {
  const color = riskScoreToHex(score);
  const fillOpacity = 0.2 + score * 0.35; // 0.20 (low) → 0.55 (high)
  return { color, fillColor: color, fillOpacity, weight: 1.5 };
}

// ── Great-circle intermediate points ──────────────────────────────────────
function greatCirclePoints(
  a: Airport,
  b: Airport,
  steps = 80
): [number, number][] {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(a.lat), lon1 = toRad(a.lon);
  const lat2 = toRad(b.lat), lon2 = toRad(b.lon);

  // Angular distance between the two points
  const d = Math.acos(
    Math.max(-1, Math.min(1,
      Math.sin(lat1) * Math.sin(lat2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
    ))
  );

  if (d === 0) return Array(steps + 1).fill([a.lat, a.lon]);

  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    // Correct spherical linear interpolation (SLERP)
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);
    points.push([
      toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
      toDeg(Math.atan2(y, x)),
    ]);
  }
  return points;
}

// ── Haversine distance (km) ───────────────────────────────────────────────
function haversineKm(a: Airport, b: Airport): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

// ── Point-in-polygon (ray casting) ────────────────────────────────────────
// ring: array of [lon, lat] pairs (GeoJSON order)
function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ── Airport marker icon ───────────────────────────────────────────────────
const airportIcon = (selected: boolean) =>
  L.divIcon({
    className: "",
    html: `<div style="
      width:10px;height:10px;border-radius:50%;
      background:${selected ? "#38bdf8" : "#64748b"};
      border:2px solid ${selected ? "#0ea5e9" : "#475569"};
      box-shadow: 0 0 ${selected ? "8px #38bdf8" : "0"};
      transition: all 0.2s;
    "></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });

// ── Main component ────────────────────────────────────────────────────────
export default function ContrailMap() {
  const mapRef = useRef<L.Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const geojsonLayerRef = useRef<L.GeoJSON | null>(null);
  // All polygon outer rings extracted directly from GeoJSON — avoids Leaflet layer traversal bugs
  const riskRingsRef = useRef<[number, number][][]>([]);

  const [airports, setAirports] = useState<Airport[]>([]);
  const [origin, setOrigin] = useState<Airport | null>(null);
  const [destination, setDestination] = useState<Airport | null>(null);
  const [aircraft, setAircraft] = useState<AircraftType>(AIRCRAFT_TYPES[1]);
  const [popupData, setPopupData] = useState<ContrailFeature | null>(null);
  const [geojsonMeta, setGeojsonMeta] = useState<Record<string, string>>({});
  // Signals when the GeoJSON rings are ready — used as a route-effect dependency
  const [ringsReady, setRingsReady] = useState(false);
  const [routeKm, setRouteKm] = useState<number>(0);
  const [routeRiskKm, setRouteRiskKm] = useState<number>(0);

  // ── Init map ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapDivRef.current) return;

    let alive = true; // guard against stale fetch callbacks after cleanup

    const map = L.map(mapDivRef.current, {
      center: [39.5, -98.35],
      zoom: 4,
      zoomControl: true,
    });

    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(map);

    markerLayerRef.current = L.layerGroup().addTo(map);
    routeLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    // Load GeoJSON overlay
    fetch("/data/latest.geojson")
      .then((r) => r.json())
      .then((gj) => {
        if (!alive) return;
        setGeojsonMeta(gj.metadata ?? {});

        // Build a flat list of outer rings for point-in-polygon checks.
        // Done here directly from the GeoJSON data — no Leaflet layer traversal needed.
        const rings: [number, number][][] = [];
        for (const feature of gj.features ?? []) {
          const geom = feature.geometry;
          if (geom?.type === "Polygon") {
            rings.push(geom.coordinates[0] as [number, number][]);
          } else if (geom?.type === "MultiPolygon") {
            for (const poly of geom.coordinates as [number, number][][][]) {
              rings.push(poly[0]);
            }
          }
        }
        riskRingsRef.current = rings;
        setRingsReady(true); // triggers route effect to re-run if airports already selected

        const layer = L.geoJSON(gj, {
          style: (feature) => {
            const props = feature?.properties as ContrailFeature | undefined;
            const score = props ? featureRiskScore(props) : 0;
            return riskStyle(score);
          },
          onEachFeature: (feature, lyr) => {
            lyr.on("click", () => {
              setPopupData(feature.properties as ContrailFeature);
            });
            lyr.on("mouseover", () => {
              const props = feature?.properties as ContrailFeature | undefined;
              const score = props ? featureRiskScore(props) : 0;
              const base = riskStyle(score);
              (lyr as L.Path).setStyle({
                ...base,
                fillOpacity: Math.min(base.fillOpacity + 0.25, 0.85),
                weight: 2.5,
              });
            });
            lyr.on("mouseout", () => {
              const props = feature?.properties as ContrailFeature | undefined;
              const score = props ? featureRiskScore(props) : 0;
              (lyr as L.Path).setStyle(riskStyle(score));
            });
          },
        });
        if (alive) {
          layer.addTo(map);
          geojsonLayerRef.current = layer;
        }
      })
      .catch(console.error);

    // Load airports
    fetch("/data/airports.json")
      .then((r) => r.json())
      .then((data: Airport[]) => {
        if (alive) setAirports(data);
      })
      .catch(console.error);

    return () => {
      alive = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Update airport markers when selection changes ───────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const ml = markerLayerRef.current;
    if (!map || !ml) return;
    ml.clearLayers();
    airports.forEach((ap) => {
      const selected = ap.code === origin?.code || ap.code === destination?.code;
      const marker = L.marker([ap.lat, ap.lon], {
        icon: airportIcon(selected),
        title: `${ap.code} — ${ap.name}`,
      });
      marker.bindTooltip(`<strong>${ap.code}</strong><br/>${ap.name}`, {
        direction: "top",
        offset: [0, -8],
        className: "leaflet-dark-tip",
      });
      marker.on("click", () => {
        if (!origin) {
          setOrigin(ap);
        } else if (!destination && ap.code !== origin.code) {
          setDestination(ap);
        } else {
          setOrigin(ap);
          setDestination(null);
        }
      });
      ml.addLayer(marker);
    });
  }, [airports, origin, destination]);

  // ── Draw route when both airports selected ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const rl = routeLayerRef.current;
    if (!map || !rl) return;
    rl.clearLayers();
    setRouteKm(0);
    setRouteRiskKm(0);

    if (!origin || !destination) return;

    const pts = greatCirclePoints(origin, destination);
    const totalKm = haversineKm(origin, destination);
    setRouteKm(Math.round(totalKm));

    // Draw route line
    L.polyline(pts, {
      color: "#38bdf8",
      weight: 2.5,
      opacity: 0.85,
      dashArray: "6 4",
    }).addTo(rl);

    // Draw endpoints
    [origin, destination].forEach((ap, i) => {
      L.circleMarker([ap.lat, ap.lon], {
        radius: 7,
        color: "#38bdf8",
        fillColor: i === 0 ? "#0ea5e9" : "#818cf8",
        fillOpacity: 1,
        weight: 2,
      })
        .bindTooltip(`<strong>${ap.code}</strong><br/>${ap.name}`, {
          direction: "top",
          offset: [0, -10],
        })
        .addTo(rl);
    });

    // Estimate km of route inside risk polygons using point-in-polygon.
    // Each route point is tested against actual polygon rings — not bounding boxes —
    // so overlapping polygons and large sparse polygons don't inflate the number.
    const rings = riskRingsRef.current;
    if (rings.length > 0) {
      const inRisk = pts.map(([lat, lon]) =>
        rings.some((ring) => pointInRing(lon, lat, ring))
      );
      const hitCount = inRisk.filter(Boolean).length;
      const riskFraction = hitCount / pts.length;
      console.debug(
        `[ContrAI] ${origin?.code}→${destination?.code}: ${hitCount}/${pts.length} pts in risk zones`,
        `(${Math.round(riskFraction * 100)}% of ${Math.round(totalKm)} km)`
      );
      setRouteRiskKm(Math.round(Math.min(riskFraction, 1) * totalKm));
    }

    // Fly map to route bounds
    const latLngs = pts.map(([lat, lon]) => L.latLng(lat, lon));
    map.fitBounds(L.latLngBounds(latLngs), { padding: [60, 60] });
  }, [origin, destination, ringsReady]);

  const handleClearRoute = () => {
    setOrigin(null);
    setDestination(null);
    setPopupData(null);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f172a]">
      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <Sidebar
        airports={airports}
        origin={origin}
        destination={destination}
        aircraft={aircraft}
        onSelectOrigin={setOrigin}
        onSelectDestination={setDestination}
        onSelectAircraft={setAircraft}
        onClear={handleClearRoute}
        geojsonMeta={geojsonMeta}
      />

      {/* ── Map area ─────────────────────────────────────────────────── */}
      <div className="relative flex-1">
        <div ref={mapDivRef} className="h-full w-full" />

        {/* ── Legend ─────────────────────────────────────────────────── */}
        <div className="absolute bottom-6 right-4 z-[500] rounded-xl border border-slate-300 bg-slate-100 px-4 py-3 shadow-lg w-40">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-800">
            Contrail Risk
          </p>
          <div
            className="h-2.5 w-full rounded-full mb-1"
            style={{
              background:
                "linear-gradient(to right, hsl(240,85%,57%), hsl(180,85%,52%), hsl(120,85%,52%), hsl(60,95%,52%), hsl(30,95%,55%), hsl(0,95%,57%))",
            }}
          />
          <div className="flex justify-between text-[10px] text-slate-800 mb-3">
            <span>Low</span>
            <span>Med</span>
            <span>High</span>
          </div>
          <div className="border-t border-slate-300 pt-2 flex items-center gap-2">
            <div className="h-0.5 w-6" style={{ borderTop: "2px dashed #3b82f6" }} />
            <span className="text-[11px] text-slate-800">Flight Route</span>
          </div>
        </div>

        {/* ── Risk popup overlay ──────────────────────────────────────── */}
        {popupData && (
          <RiskPopup data={popupData} onClose={() => setPopupData(null)} />
        )}

        {/* ── Warming panel (shows when route selected) ────────────────── */}
        {origin && destination && (
          <WarmingPanel
            origin={origin}
            destination={destination}
            aircraft={aircraft}
            routeKm={routeKm}
            routeRiskKm={routeRiskKm}
          />
        )}
      </div>
    </div>
  );
}
