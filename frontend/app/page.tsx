"use client";

import dynamic from "next/dynamic";

// Leaflet requires the browser's window object — load client-side only
const ContrailMap = dynamic(() => import("./components/ContrailMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-[#0f172a]">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-sky-500 border-t-transparent" />
        <p className="text-slate-400 text-sm tracking-wide">Loading forecast…</p>
      </div>
    </div>
  ),
});

export default function HomePage() {
  return <ContrailMap />;
}
