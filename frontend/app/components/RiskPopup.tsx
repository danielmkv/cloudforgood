"use client";

import { ContrailFeature, featureRiskScore, riskScoreToHex, riskLevelFromScore } from "./ContrailMap";

interface Props {
  data: ContrailFeature;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-neutral-500">{label}</span>
      <span className="font-medium text-neutral-200">{value}</span>
    </div>
  );
}

export default function RiskPopup({ data, onClose }: Props) {
  const score = featureRiskScore(data);
  const accentColor = riskScoreToHex(score);

  const riskLabel = data.risk_level ?? riskLevelFromScore(score);
  const isPersistent =
    riskLabel === "high" || data.label === "persistent" || score >= 0.6;

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
    <div className="absolute top-4 right-4 z-[600] w-72 rounded-xl border border-neutral-800 bg-black/95 p-4 shadow-xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <span
            className="inline-block rounded-md border px-2 py-0.5 text-xs font-bold uppercase tracking-wider"
            style={{
              color: accentColor,
              borderColor: accentColor,
              background: `color-mix(in srgb, ${accentColor} 18%, transparent)`,
            }}
          >
            {riskLabel} risk
          </span>
          <p className="mt-1.5 text-sm font-semibold text-neutral-100 leading-snug">
            {data.label === "persistent"
              ? "Persistent contrail region"
              : data.label === "short"
              ? "Short-lived contrail region"
              : (data as { label?: string }).label ?? "Contrail risk zone"}
          </p>
        </div>
        <button
          onClick={onClose}
          className="ml-2 flex-shrink-0 h-6 w-6 rounded-full flex items-center justify-center text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors text-base leading-none"
        >
          ×
        </button>
      </div>

      {/* Risk score bar */}
      <div className="mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-xs text-neutral-500">Risk Score</span>
          <span className="text-xs font-bold text-neutral-300">
            {(score * 100).toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-neutral-800">
          <div
            className="h-1.5 rounded-full transition-all"
            style={{
              width: `${score * 100}%`,
              background: `linear-gradient(to right, #fbbf24, ${accentColor})`,
            }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="space-y-2 border-t border-neutral-800 pt-3">
        <Row label="Type" value={isPersistent ? "Persistent (ISSR)" : "Short-lived"} />
        <Row label="Altitude" value={altDisplay} />
        <Row label="Temperature" value={tempC} />
        <Row label="Rel. Humidity (ice)" value={rhiDisplay} />
        <Row label="Polygon Area" value={areaDisplay} />
        <Row label="Valid Time" value={timeDisplay} />
      </div>

      {/* Interpretation */}
      <p className="mt-3 text-[11px] text-neutral-500 leading-relaxed">
        {isPersistent
          ? "Ice-supersaturated air. Contrails will persist and spread into cirrus, contributing to warming."
          : "Below ice saturation. Contrails form but quickly sublimate — lower climate impact."}
      </p>
    </div>
  );
}
