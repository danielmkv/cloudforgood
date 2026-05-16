"use client";

import { ContrailFeature, featureRiskScore, riskScoreToHex } from "./ContrailMap";

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
  const score = featureRiskScore(data);
  const accentColor = riskScoreToHex(score);

  // Derive display values — support both schemas
  const isPersistent = data.label === "persistent" || (data.risk_level === "high") || score >= 0.9;
  const riskLabel =
    data.risk_level ??
    (data.label === "persistent" ? "high" : data.label === "short" ? "medium" : "low");

  const tempC =
    data.temperature_k !== undefined
      ? `${(data.temperature_k - 273.15).toFixed(1)} °C (${data.temperature_k.toFixed(1)} K)`
      : "—";

  const rhiDisplay =
    data.rhi !== undefined ? `${(data.rhi * 100).toFixed(0)}%` : "—";

  const altDisplay =
    data.altitude_ft !== undefined
      ? `${data.altitude_ft.toLocaleString()} ft`
      : "250 hPa (~34,000 ft)";

  const areaDisplay =
    data.area_km2 !== undefined ? `${data.area_km2.toLocaleString()} km²` : "—";

  const timeDisplay =
    data.valid_time !== undefined
      ? new Date(data.valid_time).toUTCString().replace(" GMT", " UTC")
      : "—";

  return (
    <div className="absolute top-4 right-4 z-[600] w-72 rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <span
            className="inline-block rounded-md border px-2 py-0.5 text-xs font-bold uppercase tracking-wider"
            style={{
              color: accentColor,
              borderColor: accentColor,
              background: `color-mix(in srgb, ${accentColor} 15%, transparent)`,
            }}
          >
            {riskLabel} risk
          </span>
          <p className="mt-1.5 text-sm font-semibold text-slate-100 leading-snug">
            {data.label === "persistent"
              ? "Persistent contrail region"
              : data.label === "short"
              ? "Short-lived contrail region"
              : (data as { label?: string }).label ?? "Contrail risk zone"}
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
            {(score * 100).toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-700">
          <div
            className="h-1.5 rounded-full transition-all"
            style={{
              width: `${score * 100}%`,
              background: `linear-gradient(to right, hsl(240,85%,57%), ${accentColor})`,
            }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="space-y-2 border-t border-slate-800 pt-3">
        <Row label="Type" value={isPersistent ? "Persistent (ISSR)" : "Short-lived"} />
        <Row label="Altitude" value={altDisplay} />
        <Row label="Temperature" value={tempC} />
        <Row label="Rel. Humidity (ice)" value={rhiDisplay} />
        <Row label="Polygon Area" value={areaDisplay} />
        <Row label="Valid Time" value={timeDisplay} />
      </div>

      {/* Interpretation */}
      <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
        {isPersistent
          ? "Ice-supersaturated air. Contrails will persist and spread into cirrus, contributing to warming."
          : "Below ice saturation. Contrails form but quickly sublimate — lower climate impact."}
      </p>
    </div>
  );
}
