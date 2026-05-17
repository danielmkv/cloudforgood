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
      <label className="mb-1 block text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
        {label}
      </label>
      <input
        className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600 transition-colors"
        placeholder={selected ? `${selected.code} — ${selected.name}` : "Search airport…"}
        value={selected && !open ? `${selected.code} — ${selected.name}` : query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(""); }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && filtered.length > 0 && (
        <ul className="absolute z-[999] mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-lg">
          {filtered.map((ap) => (
            <li
              key={ap.code}
              className="cursor-pointer px-3 py-2 text-sm hover:bg-neutral-800 transition-colors"
              onMouseDown={() => { onSelect(ap); setOpen(false); setQuery(""); }}
            >
              <span className="font-semibold text-blue-400">{ap.code}</span>
              <span className="ml-2 text-neutral-300">{ap.name}</span>
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
    <aside className="flex h-full w-80 flex-shrink-0 flex-col border-r border-neutral-800 bg-black overflow-y-auto">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="px-5 pt-6 pb-4 border-b border-neutral-800">
        <h1 className="text-xl font-bold tracking-tight text-white leading-none">
          contraiλ
        </h1>
      </div>

      {/* ── Forecast metadata ─────────────────────────────────────────── */}
      {geojsonMeta.forecast_valid && (
        <div className="mx-4 my-3 rounded-lg bg-neutral-900 px-3 py-2.5 border border-neutral-800">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-400 mb-1.5">
            Forecast
          </p>
          <p className="text-xs text-neutral-300">
            Valid:{" "}
            <span className="text-blue-300 font-medium">
              {new Date(geojsonMeta.forecast_valid).toUTCString()}
            </span>
          </p>
          <p className="text-xs text-neutral-300 mt-0.5">
            Source: {geojsonMeta.forecast_source ?? "GFS 0.25°"}
          </p>
          <p className="text-xs text-neutral-300">
            Model: {geojsonMeta.model ?? "Schmidt–Appleman"}
          </p>
        </div>
      )}

      {/* ── Route planner ─────────────────────────────────────────────── */}
      <div className="px-4 pt-2 pb-4 border-b border-neutral-800 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
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
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 py-1.5 text-xs text-neutral-300 hover:text-red-400 hover:border-red-900 hover:bg-red-950/50 transition-colors"
          >
            Clear route
          </button>
        )}
      </div>

      {/* ── Aircraft picker ───────────────────────────────────────────── */}
      <div className="px-4 pt-3 pb-4">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-neutral-400">
          Aircraft Type
        </p>
        <div className="space-y-2">
          {AIRCRAFT_TYPES.map((ac) => (
            <button
              key={ac.id}
              onClick={() => onSelectAircraft(ac)}
              className={`w-full rounded-lg border px-3 py-2.5 text-left text-xs transition-colors ${
                aircraft.id === ac.id
                  ? "border-blue-700 bg-blue-950/50 text-blue-200"
                  : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-700 hover:bg-neutral-800"
              }`}
            >
              <span className="font-semibold block text-[13px]">{ac.label}</span>
              <span className={`text-[10px] ${aircraft.id === ac.id ? "text-blue-400" : "text-neutral-500"}`}>
                Alt: {ac.cruise_alt_ft.toLocaleString()} ft · Fuel: {ac.fuel_burn_kg_per_km} kg/km
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
