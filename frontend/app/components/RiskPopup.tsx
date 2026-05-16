"use client";

import { ContrailFeature } from "./ContrailMap";

const RISK_COLORS: Record<string, string> = {
  low: "text-violet-400 bg-violet-500/10 border-violet-700",
  medium: "text-amber-400 bg-amber-500/10 border-amber-700",
  high: "text-red-400 bg-red-500/10 border-red-700",
};

const RISK_BAR: Record<string, string> = {
  low: "bg-violet-500",
  medium: "bg-amber-500",
  high: "bg-red-500",
};

interface Props {
  data: ContrailFeature;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="font-medium text-slate-200">{value}</span>
    </div>
  );
}

export default function RiskPopup({ data, onClose }: Props) {
  const risk = data.risk_level;
  const colorClass = RISK_COLORS[risk] ?? RISK_COLORS.low;
  const barClass = RISK_BAR[risk] ?? RISK_BAR.low;
  const tempC = (data.temperature_k - 273.15).toFixed(1);
  const rhiPct = (data.rhi * 100).toFixed(0);

  return (
    <div className="absolute top-4 right-4 z-[600] w-72 rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <span
            className={`inline-block rounded-md border px-2 py-0.5 text-xs font-bold uppercase tracking-wider ${colorClass}`}
          >
            {risk} risk
          </span>
          <p className="mt-1.5 text-sm font-semibold text-slate-100 leading-snug">
            {data.label}
          </p>
        </div>
        <button
          onClick={onClose}
          className="ml-2 flex-shrink-0 text-slate-500 hover:text-slate-200 transition-colors text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Risk score bar */}
      <div className="mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-xs text-slate-400">Risk Score</span>
          <span className="text-xs font-bold text-slate-200">
            {(data.risk_score * 100).toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-700">
          <div
            className={`h-1.5 rounded-full transition-all ${barClass}`}
            style={{ width: `${data.risk_score * 100}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="space-y-2 border-t border-slate-800 pt-3">
        <Row label="Altitude" value={`${data.altitude_ft.toLocaleString()} ft`} />
        <Row label="Temperature" value={`${tempC} °C (${data.temperature_k.toFixed(1)} K)`} />
        <Row label="Rel. Humidity (ice)" value={`${rhiPct}%`} />
        <Row label="Polygon Area" value={`${data.area_km2.toLocaleString()} km²`} />
        <Row
          label="Valid Time"
          value={new Date(data.valid_time).toUTCString().replace(" GMT", " UTC")}
        />
      </div>

      {/* Interpretation */}
      <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
        {risk === "high" &&
          "High ice-supersaturation. Contrails likely to persist and spread, contributing to warming."}
        {risk === "medium" &&
          "Moderate ice-supersaturation. Short-lived contrails possible; cirrus formation likely at cruise altitude."}
        {risk === "low" &&
          "Near-threshold humidity. Contrails may form briefly but will quickly sublimate."}
      </p>
    </div>
  );
}
