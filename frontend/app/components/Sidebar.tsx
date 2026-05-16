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
      <label className="mb-1 block text-xs font-semibold uppercase tracking-widest text-slate-400">
        {label}
      </label>
      <input
        className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
        placeholder={selected ? `${selected.code} — ${selected.name}` : "Search airport…"}
        value={selected && !open ? `${selected.code} — ${selected.name}` : query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-[999] mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl">
          {filtered.map((ap) => (
            <li
              key={ap.code}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-slate-700"
              onMouseDown={() => {
                onSelect(ap);
                setOpen(false);
                setQuery("");
              }}
            >
              <span className="font-semibold text-sky-400">{ap.code}</span>
              <span className="ml-2 text-slate-300">{ap.name}</span>
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
    <aside className="flex h-full w-80 flex-shrink-0 flex-col border-r border-slate-800 bg-slate-900 overflow-y-auto">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="px-5 pt-6 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-2 mb-1">
          <div className="h-2.5 w-2.5 rounded-full bg-sky-400 animate-pulse" />
          <h1 className="text-lg font-bold tracking-tight text-white">ContrAI</h1>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          Contrail formation risk prediction powered by{" "}
          <span className="text-sky-400">pycontrails</span> &amp; GFS weather data.
        </p>
      </div>

      {/* ── Forecast metadata ─────────────────────────────────────────── */}
      {geojsonMeta.forecast_valid && (
        <div className="mx-4 my-3 rounded-lg bg-slate-800/60 px-3 py-2 border border-slate-700">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">
            Forecast
          </p>
          <p className="text-xs text-slate-300">
            Valid:{" "}
            <span className="text-sky-300 font-medium">
              {new Date(geojsonMeta.forecast_valid).toUTCString()}
            </span>
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            Source: {geojsonMeta.forecast_source ?? "GFS 0.25°"}
          </p>
          <p className="text-xs text-slate-400">
            Model: {geojsonMeta.model ?? "CoCiP"}
          </p>
        </div>
      )}

      {/* ── Route planner ─────────────────────────────────────────────── */}
      <div className="px-4 pt-2 pb-4 border-b border-slate-800 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
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
            className="w-full rounded-lg border border-slate-700 bg-slate-800 py-1.5 text-xs text-slate-400 hover:text-red-400 hover:border-red-800 transition-colors"
          >
            Clear route
          </button>
        )}
      </div>

      {/* ── Aircraft picker ───────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-4 border-b border-slate-800">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
          Aircraft Type
        </p>
        <div className="space-y-2">
          {AIRCRAFT_TYPES.map((ac) => (
            <button
              key={ac.id}
              onClick={() => onSelectAircraft(ac)}
              className={`w-full rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                aircraft.id === ac.id
                  ? "border-sky-500 bg-sky-500/10 text-sky-300"
                  : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600 hover:text-slate-200"
              }`}
            >
              <span className="font-semibold block">{ac.label}</span>
              <span className="text-[10px] text-slate-500">
                Alt: {ac.cruise_alt_ft.toLocaleString()} ft · Fuel:{" "}
                {ac.fuel_burn_kg_per_km} kg/km
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── How it works ─────────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-400">
          How It Works
        </p>
        <ol className="space-y-2">
          {[
            { n: "1", text: "GFS weather data fetched every 6 h from NOAA" },
            { n: "2", text: "pycontrails CoCiP model evaluates ISSR conditions" },
            { n: "3", text: "Risk polygons published to S3 as GeoJSON" },
            { n: "4", text: "CloudFront delivers latest.geojson to this map" },
          ].map(({ n, text }) => (
            <li key={n} className="flex gap-2 text-xs text-slate-400">
              <span className="flex-shrink-0 h-4 w-4 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center text-[10px] font-bold">
                {n}
              </span>
              <span>{text}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* ── Footer ───────────────────────────────────────────────────── */}
      <div className="mt-auto px-4 py-3 border-t border-slate-800">
        <p className="text-[10px] text-slate-600 text-center">
          Cloud For Good · Team ContrAI · AWS Hackathon 2026
        </p>
      </div>
    </aside>
  );
}
