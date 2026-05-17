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

/** Minimum intensity at which a polygon counts as a "risk zone" for route math
 * and for the popup high/medium/low label. Polygons below this are too faint
 * to be meaningful (lightest navy tier just means "cold air at altitude"). */
export const RISK_THRESHOLD = 0.4;

/** High/medium/low label derived from the unified risk score. */
export function riskLevelFromScore(score: number): "high" | "medium" | "low" {
  if (score >= 0.6) return "high";
  if (score >= RISK_THRESHOLD) return "medium";
  return "low";
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

// ── 5-tier palette: dark navy at low intensity, lightening through blues, yellow at the top.
// Matches the predict Lambda's intensity steps (0.1, 0.25, 0.4, 0.6, 0.8).
export function riskScoreToHex(score: number): string {
  if (score < 0.175) return "#1c2e54"; // 0.10: deep navy, near basemap
  if (score < 0.325) return "#2d5fa8"; // 0.25: navy
  if (score < 0.500) return "#5b94d6"; // 0.40: blue
  if (score < 0.700) return "#9bc8f0"; // 0.60: pale sky
  return "#fde68a";                    // 0.80+: light yellow pop
}

function riskStyle(score: number) {
  const color = riskScoreToHex(score);
  const fillOpacity = 0.22 + score * 0.4; // 0.26 (0.10) → 0.54 (0.80)
  return { color, fillColor: color, fillOpacity, weight: 0, stroke: false };
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
// 10px visible dot, 28px transparent hit area for easier hover/click.
const airportIcon = (selected: boolean) =>
  L.divIcon({
    className: "",
    html: `<div style="
      width:28px;height:28px;
      display:flex;align-items:center;justify-content:center;
      cursor:pointer;
    "><div style="
      width:10px;height:10px;border-radius:50%;
      background:${selected ? "#38bdf8" : "#64748b"};
      border:2px solid ${selected ? "#0ea5e9" : "#475569"};
      box-shadow: 0 0 ${selected ? "8px #38bdf8" : "0"};
      transition: all 0.2s;
    "></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

// ── Main component ────────────────────────────────────────────────────────
export default function ContrailMap() {
  const mapRef = useRef<L.Map | null>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const geojsonLayerRef = useRef<L.GeoJSON | null>(null);
  // All polygon outer rings extracted directly from GeoJSON — avoids Leaflet layer traversal bugs
  const riskRingsRef = useRef<Array<{ ring: [number, number][]; intensity: number }>>([]);

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

    // Load GeoJSON overlay from CloudFront, refreshed periodically.
    const GEOJSON_URL = "https://d2i587kxonhi5h.cloudfront.net/latest.geojson";
    const loadGeojson = () =>
      fetch(GEOJSON_URL, { cache: "no-store" })
        .then((r) => r.json())
        .then((gj) => {
          if (!alive) return;
          setGeojsonMeta(gj.metadata ?? {});

          const rings: Array<{ ring: [number, number][]; intensity: number }> = [];
          for (const feature of gj.features ?? []) {
            const intensity = featureRiskScore(feature.properties as ContrailFeature);
            // Skip the 0.10 tier: it covers most cold airspace and is visually
            // indistinguishable from the basemap, so counting it just gives every
            // northern flight a phantom 10% floor.
            if (intensity < 0.2) continue;
            const geom = feature.geometry;
            if (geom?.type === "Polygon") {
              rings.push({ ring: geom.coordinates[0] as [number, number][], intensity });
            } else if (geom?.type === "MultiPolygon") {
              for (const poly of geom.coordinates as [number, number][][][]) {
                rings.push({ ring: poly[0], intensity });
              }
            }
          }
          // Sort highest intensity first so route math can short-circuit per point.
          rings.sort((a, b) => b.intensity - a.intensity);
          riskRingsRef.current = rings;
          setRingsReady(true);

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
          if (!alive) return;
          if (geojsonLayerRef.current) map.removeLayer(geojsonLayerRef.current);
          layer.addTo(map);
          geojsonLayerRef.current = layer;
        })
        .catch(console.error);

    loadGeojson();
    const geojsonPollId = window.setInterval(loadGeojson, 5 * 60 * 1000);

    // Load airports
    fetch("/data/airports.json")
      .then((r) => r.json())
      .then((data: Airport[]) => {
        if (alive) setAirports(data);
      })
      .catch(console.error);

    return () => {
      alive = false;
      window.clearInterval(geojsonPollId);
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

    // Weighted route risk: at each route point, take the max intensity of any
    // containing polygon, then average across all points. A route through faint
    // 0.25 zones scores ~0.25; one crossing a 0.8 hotspot scores higher.
    // Rings are pre-sorted highest-intensity-first, so we can short-circuit.
    const rings = riskRingsRef.current;
    if (rings.length > 0) {
      let weightedSum = 0;
      for (const [lat, lon] of pts) {
        for (const { ring, intensity } of rings) {
          if (pointInRing(lon, lat, ring)) {
            weightedSum += intensity;
            break;
          }
        }
      }
      const riskFraction = weightedSum / pts.length;
      console.debug(
        `[ContrAI] ${origin?.code}→${destination?.code}: avg intensity ${riskFraction.toFixed(3)}`,
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
        <div className="absolute bottom-6 right-4 z-[500] rounded-xl border border-neutral-800 bg-black/90 px-4 py-3 shadow-lg w-44">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
            Contrail Intensity
          </p>
          <div className="flex gap-px h-3 w-full rounded-sm overflow-hidden mb-1.5">
            {[0.10, 0.25, 0.40, 0.60, 0.80].map((v) => (
              <div key={v} className="flex-1" style={{ background: riskScoreToHex(v) }} />
            ))}
          </div>
          <div className="flex justify-between text-[10px] text-neutral-400 mb-3">
            <span>0.1</span>
            <span>0.25</span>
            <span>0.4</span>
            <span>0.6</span>
            <span>0.8</span>
          </div>
          <div className="border-t border-neutral-800 pt-2 flex items-center gap-2">
            <div className="h-0.5 w-6" style={{ borderTop: "2px dashed #60a5fa" }} />
            <span className="text-[11px] text-neutral-400">Flight Route</span>
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
