"use client";

import { useState } from "react";
import { Airport, AircraftType, AIRCRAFT_TYPES } from "./ContrailMap";

interface Props {
  airports: Airport[];
  origin: Airport | null;
  destination: Airport | null;
  aircraft: AircraftType;
  onSelectOrigin: (a: Airport) => void;
  onSelectDestination: (a: Airport) => void;
  onSelectAircraft: (a: AircraftType) => void;
  onClear: () => void;
  geojsonMeta: Record<string, string>;
}

function AirportSearch({
  label,
  airports,
  selected,
  onSelect,
  exclude,
}: {
  label: string;
  airports: Airport[];
  selected: Airport | null;
  onSelect: (a: Airport) => void;
  exclude?: Airport | null;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = airports
    .filter(
      (a) =>
        a.code !== exclude?.code &&
        (a.code.toLowerCase().includes(query.toLowerCase()) ||
          a.name.toLowerCase().includes(query.toLowerCase()))
    )
    .slice(0, 8);

  return (
    <div className="relative">
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-slate-900">
        {label}
      </label>
      <input
        className="w-full rounded-lg border border-slate-300 bg-slate-200/50 px-3 py-2 text-sm text-slate-700 placeholder-gray-400 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400 transition-colors"
        placeholder={selected ? `${selected.code} — ${selected.name}` : "Search airport…"}
        value={selected && !open ? `${selected.code} — ${selected.name}` : query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-[999] mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-300 bg-slate-100 shadow-lg">
          {filtered.map((ap) => (
            <li
              key={ap.code}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-blue-100 transition-colors"
              onMouseDown={() => { onSelect(ap); setOpen(false); setQuery(""); }}
            >
              <span className="font-semibold text-blue-600">{ap.code}</span>
              <span className="ml-2 text-slate-900">{ap.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Sidebar({
  airports,
  origin,
  destination,
  aircraft,
  onSelectOrigin,
  onSelectDestination,
  onSelectAircraft,
  onClear,
  geojsonMeta,
}: Props) {
  return (
    <aside className="flex h-full w-80 flex-shrink-0 flex-col border-r border-slate-300 bg-slate-100 overflow-y-auto shadow-sm">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="px-5 pt-6 pb-4 border-b border-slate-200">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 shadow-sm">
            <svg className="h-4 w-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 15l4-8 5 4 4-6 5 3" />
            </svg>
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight text-slate-800 leading-none">ContrAI</h1>
            <p className="text-[10px] text-slate-900 leading-none mt-0.5">Cloud For Good</p>
          </div>
          <span className="ml-auto flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-600 border border-green-200">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
            Live
          </span>
        </div>
        <p className="mt-2 text-xs text-slate-900 leading-relaxed">
          Contrail formation risk powered by GFS weather data &amp; Schmidt–Appleman criterion.
        </p>
      </div>

      {/* ── Forecast metadata ─────────────────────────────────────────── */}
      {geojsonMeta.forecast_valid && (
        <div className="mx-4 my-3 rounded-lg bg-blue-100/70 px-3 py-2.5 border border-blue-200">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-500 mb-1.5">
            Forecast
          </p>
          <p className="text-xs text-slate-900">
            Valid:{" "}
            <span className="text-blue-600 font-medium">
              {new Date(geojsonMeta.forecast_valid).toUTCString()}
            </span>
          </p>
          <p className="text-xs text-slate-900 mt-0.5">
            Source: {geojsonMeta.forecast_source ?? "GFS 0.25°"}
          </p>
          <p className="text-xs text-slate-900">
            Model: {geojsonMeta.model ?? "Schmidt–Appleman"}
          </p>
        </div>
      )}

      {/* ── Route planner ─────────────────────────────────────────────── */}
      <div className="px-4 pt-2 pb-4 border-b border-slate-200 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-900">
          Route Planner
        </p>
        <AirportSearch
          label="Origin"
          airports={airports}
          selected={origin}
          onSelect={onSelectOrigin}
          exclude={destination}
        />
        <AirportSearch
          label="Destination"
          airports={airports}
          selected={destination}
          onSelect={onSelectDestination}
          exclude={origin}
        />
        {(origin || destination) && (
          <button
            onClick={onClear}
            className="w-full rounded-lg border border-slate-300 bg-slate-200/50 py-1.5 text-xs text-slate-900 hover:text-red-500 hover:border-red-200 hover:bg-red-50 transition-colors"
          >
            Clear route
          </button>
        )}
      </div>

      {/* ── Aircraft picker ───────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-4 border-b border-slate-200">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-slate-900">
          Aircraft Type
        </p>
        <div className="space-y-2">
          {AIRCRAFT_TYPES.map((ac) => (
            <button
              key={ac.id}
              onClick={() => onSelectAircraft(ac)}
              className={`w-full rounded-lg border px-3 py-2.5 text-left text-xs transition-colors ${
                aircraft.id === ac.id
                  ? "border-blue-300 bg-blue-100/70 text-blue-700"
                  : "border-slate-300 bg-slate-100 text-slate-900 hover:border-gray-300 hover:bg-slate-200/50"
              }`}
            >
              <span className="font-semibold block text-[13px]">{ac.label}</span>
              <span className={`text-[10px] ${aircraft.id === ac.id ? "text-blue-500" : "text-slate-900"}`}>
                Alt: {ac.cruise_alt_ft.toLocaleString()} ft · Fuel: {ac.fuel_burn_kg_per_km} kg/km
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-4">
        <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-slate-900">
          How It Works
        </p>
        <ol className="space-y-2.5">
          {[
            { n: "1", text: "GFS weather data fetched every 6 h from NOAA" },
            { n: "2", text: "Schmidt–Appleman criterion evaluates ISSR conditions" },
            { n: "3", text: "Risk polygons published to S3 as GeoJSON" },
            { n: "4", text: "CloudFront delivers latest.geojson to this map" },
          ].map(({ n, text }) => (
            <li key={n} className="flex gap-2.5 text-xs text-slate-900">
              <span className="flex-shrink-0 h-5 w-5 rounded-full bg-blue-600 text-white flex items-center justify-center text-[10px] font-bold shadow-sm">
                {n}
              </span>
              <span className="leading-relaxed">{text}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <div className="mt-auto px-4 py-3 border-t border-slate-200">
        <p className="text-[10px] text-slate-900 text-center">
          Cloud For Good · Team ContrAI · AWS Hackathon 2026
        </p>
      </div>
    </aside>
  );
}
