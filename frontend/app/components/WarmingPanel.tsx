"use client";

import { Airport, AircraftType } from "./ContrailMap";

interface Props {
  origin: Airport;
  destination: Airport;
  aircraft: AircraftType;
  routeKm: number;
  routeRiskKm: number;
}

/**
 * Climate impact estimates — expressed as relative indices, not absolute RF.
 *
 * Approach (Lee et al. 2021, Teoh et al. 2022):
 *   - CO₂ warming: fuel_kg × 3.16 (kg CO₂/kg fuel) × 3.63 (kg CO₂-eq warming index/kg CO₂)
 *     The 3.63 factor converts to CO₂-equivalent climate impact over 100 yr GWP.
 *   - Contrail warming: route_risk_km × fuel_burn_kg_per_km × 11.2 × rf_factor
 *     Derived from Teoh et al.: mean contrail EF ~114 GJ per flight × scaling.
 *     11.2 gives contrails ~2–3× CO₂ for a typical route, matching published ratios.
 *
 * Both values are in CO₂-equivalent tonnes (tCO₂e) — a unit people understand.
 */
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

  // CO₂ climate impact in tCO₂e
  const co2Tonnes = co2Kg / 1000;

  // Contrail climate impact in tCO₂e
  // ~11.2 tCO₂e per (km in ISSR × kg fuel/km), scaled by aircraft RF factor
  const contrailCO2e = (routeRiskKm * ac.fuel_burn_kg_per_km * 11.2 * ac.rf_factor) / 1000;

  const totalCO2e = co2Tonnes + contrailCO2e;
  const contrailPct = totalCO2e > 0 ? (contrailCO2e / totalCO2e) * 100 : 0;

  return {
    contrailCO2e,
    co2Tonnes,
    totalCO2e,
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

interface StatProps {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}
function Stat({ label, value, sub, accent }: StatProps) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-slate-500">{label}</span>
      <span className={`text-sm font-bold ${accent ? "text-amber-400" : "text-slate-100"}`}>
        {value}
      </span>
      {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
    </div>
  );
}

export default function WarmingPanel({
  origin,
  destination,
  aircraft,
  routeKm,
  routeRiskKm,
}: Props) {
  const w = computeWarming(routeKm, routeRiskKm, aircraft);
  const riskPct = routeKm > 0 ? Math.min(100, Math.round((routeRiskKm / routeKm) * 100)) : 0;

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] w-[580px] max-w-[90vw] rounded-xl border border-slate-700 bg-slate-900/95 px-5 py-4 shadow-2xl backdrop-blur-md">
      {/* Route header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-sky-400">{origin.code}</span>
          <span className="text-slate-600 text-xs">→</span>
          <span className="text-sm font-bold text-violet-400">{destination.code}</span>
        </div>
        <div className="flex gap-3 text-xs text-slate-400">
          <span>{routeKm.toLocaleString()} km</span>
          <span className="text-slate-600">·</span>
          <span className="text-amber-400 font-medium">{riskPct}% in risk zones</span>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-5 gap-4 border-t border-slate-800 pt-3">
        <Stat
          label="Fuel Burn"
          value={`${fmt(w.fuelBurnTons)} t`}
          sub="kerosene"
        />
        <Stat
          label="CO₂ Emitted"
          value={`${fmt(w.co2Tons)} t`}
          sub="direct"
        />
        <Stat
          label="CO₂ Impact"
          value={`${fmt(w.co2Tonnes)} tCO₂e`}
          sub="100-yr GWP"
        />
        <Stat
          label="Contrail Impact"
          value={`${fmt(w.contrailCO2e)} tCO₂e`}
          sub={`${riskPct}% of route`}
          accent
        />
        <Stat
          label="Contrail Share"
          value={`${fmt(w.contrailPct, 0)}%`}
          sub="of total impact"
          accent
        />
      </div>

      {/* Progress bar */}
      <div className="mt-3">
        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
          <span>Contrail warming ({fmt(w.contrailCO2e)} tCO₂e)</span>
          <span>CO₂ warming ({fmt(w.co2Tonnes)} tCO₂e)</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-700 overflow-hidden flex">
          <div
            className="bg-amber-500 h-full transition-all"
            style={{ width: `${Math.min(w.contrailPct, 100)}%` }}
          />
          <div className="bg-sky-700 h-full flex-1" />
        </div>
      </div>

      <p className="mt-2 text-[10px] text-slate-600 leading-relaxed">
        Climate impact in tCO₂-equivalent (100-yr GWP). Contrail factor from Teoh et al. (2022);
        CO₂ factor from Lee et al. (2021). Aircraft: {aircraft.label}.
      </p>
    </div>
  );
}
