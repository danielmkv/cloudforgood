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
 * Warming impact calculation — based on the design doc formula:
 *
 *   contrail_warming_mW_m2 =
 *     route_distance_inside_predicted_risk_km
 *     × fuel_burn_kg_per_km
 *     × EI_soot (1.0e15 particles/kg)
 *     × RF_per_particle (1.5e-17 W m⁻² particle⁻¹)
 *     × aircraft_rf_factor
 *
 *   co2_warming_mW_m2 =
 *     route_distance_km × fuel_burn_kg_per_km × 3.16 (kg CO₂/kg fuel)
 *     × 0.0022 (mW m⁻² per kg CO₂)
 *
 * Numbers are illustrative / order-of-magnitude for the demo.
 */
function computeWarming(
  routeKm: number,
  routeRiskKm: number,
  ac: AircraftType
): {
  contrailRF: number;
  co2RF: number;
  totalRF: number;
  fuelBurnTons: number;
  co2Tons: number;
  contrailPct: number;
} {
  const EI_soot = 1.0e15; // soot particles per kg fuel
  const RF_per_particle = 1.5e-17; // W m⁻² per particle
  const mW_factor = 1000;

  const contrailRF =
    routeRiskKm *
    ac.fuel_burn_kg_per_km *
    EI_soot *
    RF_per_particle *
    ac.rf_factor *
    mW_factor;

  const fuelBurnKg = routeKm * ac.fuel_burn_kg_per_km;
  const co2Kg = fuelBurnKg * 3.16;
  const co2RF = co2Kg * 0.0022;

  const totalRF = contrailRF + co2RF;
  const contrailPct = totalRF > 0 ? (contrailRF / totalRF) * 100 : 0;

  return {
    contrailRF,
    co2RF,
    totalRF,
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
  const riskPct = routeKm > 0 ? Math.round((routeRiskKm / routeKm) * 100) : 0;

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[500] w-[560px] max-w-[90vw] rounded-xl border border-slate-700 bg-slate-900/95 px-5 py-4 shadow-2xl backdrop-blur-md">
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
          label="CO₂"
          value={`${fmt(w.co2Tons)} t`}
          sub="emitted"
        />
        <Stat
          label="CO₂ RF"
          value={`${fmt(w.co2RF, 2)} mW/m²`}
          sub="long-lived"
        />
        <Stat
          label="Contrail RF"
          value={`${fmt(w.contrailRF, 2)} mW/m²`}
          sub={`${riskPct}% of route`}
          accent
        />
        <Stat
          label="Contrail Share"
          value={`${fmt(w.contrailPct, 0)}%`}
          sub="of total RF"
          accent
        />
      </div>

      {/* Progress bar: contrail vs CO2 share */}
      <div className="mt-3">
        <div className="flex justify-between text-[10px] text-slate-500 mb-1">
          <span>Contrail warming</span>
          <span>CO₂ warming</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-700 overflow-hidden flex">
          <div
            className="bg-amber-500 h-full transition-all"
            style={{ width: `${w.contrailPct}%` }}
          />
          <div className="bg-sky-700 h-full flex-1" />
        </div>
      </div>

      <p className="mt-2 text-[10px] text-slate-600 leading-relaxed">
        Radiative forcing values are illustrative estimates using the Schmidt–Appleman criterion
        and pycontrails CoCiP model. Aircraft: {aircraft.label}.
      </p>
    </div>
  );
}
