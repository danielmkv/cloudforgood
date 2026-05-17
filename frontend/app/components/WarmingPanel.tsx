"use client";

import { useState } from "react";
import { Airport, AircraftType } from "./ContrailMap";

interface Props {
  origin: Airport;
  destination: Airport;
  aircraft: AircraftType;
  routeKm: number;
  routeRiskKm: number;
}

function computeWarming(
  routeKm: number,
  routeRiskKm: number,
  ac: AircraftType
): {
  contrailCO2e: number;
  co2Tonnes: number;
  totalCO2e: number;
  fuelBurnTons: number;
  co2Tons: number;
  contrailPct: number;
} {
  const fuelBurnKg = routeKm * ac.fuel_burn_kg_per_km;
  const co2Kg = fuelBurnKg * 3.16;
  const co2Tonnes = co2Kg / 1000;
  const contrailCO2e = (routeRiskKm * ac.fuel_burn_kg_per_km * 11.2 * ac.rf_factor) / 1000;
  const totalCO2e = co2Tonnes + contrailCO2e;
  const contrailPct = totalCO2e > 0 ? (contrailCO2e / totalCO2e) * 100 : 0;
  return {
    contrailCO2e, co2Tonnes, totalCO2e,
    fuelBurnTons: fuelBurnKg / 1000,
    co2Tons: co2Kg / 1000,
    contrailPct,
  };
}

function fmt(n: number, decimals = 1): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function riskColor(contrailPct: number): string {
  if (contrailPct >= 60) return "#dc2626"; // red-600
  if (contrailPct >= 30) return "#f97316"; // orange-500
  if (contrailPct >= 10) return "#f59e0b"; // amber-500
  return "#22c55e";                         // green-500
}

interface StatProps {
  label: string;
  value: string;
  sub?: string;
  accentColor?: string;
}
function Stat({ label, value, sub, accentColor }: StatProps) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-neutral-500">{label}</span>
      <span
        className="text-sm font-bold"
        style={{ color: accentColor ?? "#e5e7eb" }}
      >
        {value}
      </span>
      {sub && <span className="text-[10px] text-neutral-500">{sub}</span>}
    </div>
  );
}

const metricHelp = [
  {
    label: "Route Distance",
    description:
      "The great-circle distance between the selected origin and destination airports.",
  },
  {
    label: "Risk Zones",
    description:
      "The share of the route that crosses forecast regions with meaningful contrail persistence risk.",
  },
  {
    label: "Fuel Burn",
    description:
      "Estimated kerosene consumed over the route using the selected aircraft type's fuel burn rate.",
  },
  {
    label: "CO₂ Emitted",
    description:
      "Direct carbon dioxide released by burning the estimated fuel load.",
  },
  {
    label: "CO₂ Impact",
    description:
      "The direct CO₂ warming impact expressed as tonnes of CO₂ equivalent over a 100-year horizon.",
  },
  {
    label: "Contrail Impact",
    description:
      "Estimated warming from persistent contrails on risky route segments, expressed as tonnes of CO₂ equivalent.",
  },
  {
    label: "Contrail Share",
    description:
      "The percent of total estimated warming caused by contrails instead of direct CO₂ emissions.",
  },
];

export default function WarmingPanel({
  origin,
  destination,
  aircraft,
  routeKm,
  routeRiskKm,
}: Props) {
  const [showMetricHelp, setShowMetricHelp] = useState(false);
  const w = computeWarming(routeKm, routeRiskKm, aircraft);
  const riskPct = routeKm > 0 ? Math.min(100, Math.round((routeRiskKm / routeKm) * 100)) : 0;
  const color = riskColor(w.contrailPct);

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] w-[580px] max-w-[90vw] rounded-xl border border-neutral-800 bg-black/95 px-5 py-4 shadow-xl">
      {/* Route header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-blue-400">{origin.code}</span>
          <span className="text-neutral-500 text-xs">→</span>
          <span className="text-sm font-bold text-violet-400">{destination.code}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-400">
          <span>{routeKm.toLocaleString()} km</span>
          <span className="text-neutral-700">·</span>
          <span className="font-semibold" style={{ color }}>{riskPct}% in risk zones</span>
          <button
            type="button"
            aria-expanded={showMetricHelp}
            aria-controls="warming-panel-metric-help"
            onClick={() => setShowMetricHelp((open) => !open)}
            className="inline-flex h-6 items-center gap-1 rounded-full border border-neutral-700 px-2 text-[11px] font-semibold text-neutral-300 transition-colors hover:border-blue-500 hover:text-blue-300"
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border border-current text-[10px] leading-none">
              i
            </span>
            Info
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-4 border-t border-neutral-800 pt-3">
        <Stat label="Fuel Burn"       value={`${fmt(w.fuelBurnTons)} t`}      sub="kerosene" />
        <Stat label="CO₂ Emitted"    value={`${fmt(w.co2Tons)} t`}            sub="direct" />
        <Stat label="CO₂ Impact"     value={`${fmt(w.co2Tonnes)} tCO₂e`}      sub="100-yr GWP" />
        <Stat label="Contrail Impact" value={`${fmt(w.contrailCO2e)} tCO₂e`}  sub={`${riskPct}% of route`} accentColor={color} />
        <Stat label="Contrail Share"  value={`${fmt(w.contrailPct, 0)}%`}     sub="of total impact" accentColor={color} />
      </div>

      {/* Progress bar */}
      <div className="mt-3">
        <div className="flex justify-between text-[10px] text-neutral-500 mb-1">
          <span>Contrail warming ({fmt(w.contrailCO2e)} tCO₂e)</span>
          <span>CO₂ warming ({fmt(w.co2Tonnes)} tCO₂e)</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-neutral-800 overflow-hidden flex">
          <div
            className="h-full transition-all"
            style={{ width: `${Math.min(w.contrailPct, 100)}%`, backgroundColor: color }}
          />
          <div className="bg-blue-900 h-full flex-1" />
        </div>
      </div>

      {showMetricHelp && (
        <div
          id="warming-panel-metric-help"
          className="mt-3 grid grid-cols-2 gap-x-5 gap-y-2 rounded-lg border border-neutral-800 bg-neutral-950/90 p-3"
        >
          {metricHelp.map((metric) => (
            <div key={metric.label}>
              <p className="text-[11px] font-semibold text-neutral-200">
                {metric.label}
              </p>
              <p className="text-[11px] leading-relaxed text-neutral-500">
                {metric.description}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
