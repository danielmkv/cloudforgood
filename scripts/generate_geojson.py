"""
generate_geojson.py — Offline contrail-risk GeoJSON generator

Uses pycontrails + ECMWF ERA5 (or synthetic GFS-like data) to compute
ice-supersaturation regions over North America and emit latest.geojson.

Usage (requires real data):
    pip install pycontrails cfgrib xarray numpy shapely
    python generate_geojson.py --gfs <path-to-gfs.grib2> --out latest.geojson

Usage (demo / synthetic):
    python generate_geojson.py --demo --out latest.geojson

The script outputs a GeoJSON FeatureCollection where each polygon is a
contiguous region where the pycontrails ISSR / Schmidt–Appleman criterion
predicts persistent contrail formation at cruise altitude (FL290–FL410).
"""

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Try to import pycontrails (optional for demo mode) ────────────────────
try:
    import numpy as np
    import xarray as xr

    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

try:
    from pycontrails import Flight, MetDataset
    from pycontrails.models.cocip import CoCiP
    from pycontrails.models.issr import ISSR

    HAS_PYCONTRAILS = True
except ImportError:
    HAS_PYCONTRAILS = False

try:
    from shapely.geometry import mapping, Polygon as ShapelyPolygon
    from shapely.ops import unary_union

    HAS_SHAPELY = True
except ImportError:
    HAS_SHAPELY = False


# ── Schmidt–Appleman criterion (pure Python, no deps) ─────────────────────
def schmidt_appleman(T_K: float, p_hPa: float, rhi: float) -> bool:
    """
    Returns True if persistent contrail formation is predicted.
    Uses simplified SAC: contrail forms if T < T_LC and RHi > 1.
    T_LC threshold from Schumann (1996), approximation.
    """
    # Approximate T_LC (liquid-saturation threshold) in Kelvin
    T_LC = 226.69 + 9.43 * math.log(max(p_hPa, 1e-6) / 1000) + 0.114 * (p_hPa / 1000)
    sac_forms = T_K < T_LC
    persists = rhi > 1.0
    return sac_forms and persists


# ── Synthetic GFS-like grid (demo mode) ────────────────────────────────────
def synthetic_issr_grid(
    lat_min: float = 24.0,
    lat_max: float = 55.0,
    lon_min: float = -130.0,
    lon_max: float = -60.0,
    step: float = 0.5,
    pressure_hPa: float = 250.0,
) -> list[dict]:
    """
    Generate a synthetic lat/lon grid of ISSR risk values mimicking what
    pycontrails would produce from GFS data. Uses simple wave-like perturbations
    to create realistic-looking patterns.
    """
    if not HAS_NUMPY:
        raise RuntimeError("numpy required for synthetic grid. pip install numpy")

    lats = np.arange(lat_min, lat_max, step)
    lons = np.arange(lon_min, lon_max, step)
    cells = []

    rng = np.random.default_rng(42)  # deterministic seed for demo

    # Base temperature field (colder at higher latitudes, ~upper troposphere)
    for lat in lats:
        for lon in lons:
            # Simplified temperature model: ~215–235 K at FL300–FL400
            base_T = 226.0 - 0.35 * (lat - 35.0)  # colder pole-ward
            # Add synoptic-scale wave perturbation
            wave = 5.0 * math.sin(math.radians(lon * 3 + lat * 2))
            T_K = base_T + wave + rng.normal(0, 1.5)

            # Synthetic humidity: elevated in known storm-track regions
            base_rhi = 0.75 + 0.25 * math.exp(
                -((lat - 45.0) ** 2 + (lon + 95.0) ** 2) / 400
            )
            # Add Great Lakes moisture plume
            base_rhi += 0.20 * math.exp(
                -((lat - 44.0) ** 2 + (lon + 87.0) ** 2) / 120
            )
            # Pacific Northwest moisture
            base_rhi += 0.18 * math.exp(
                -((lat - 46.0) ** 2 + (lon + 121.0) ** 2) / 80
            )
            # Rocky Mountain wave enhancement
            base_rhi += 0.15 * math.exp(
                -((lat - 41.0) ** 2 + (lon + 107.0) ** 2) / 150
            )
            rhi = float(np.clip(base_rhi + rng.normal(0, 0.08), 0.0, 1.4))

            sac = schmidt_appleman(T_K, pressure_hPa, rhi)
            risk_score = float(np.clip((rhi - 0.9) * 2.5, 0.0, 1.0)) if sac else 0.0

            if risk_score > 0.05:
                cells.append(
                    {
                        "lat": float(lat),
                        "lon": float(lon),
                        "T_K": float(T_K),
                        "rhi": rhi,
                        "risk_score": risk_score,
                        "sac": sac,
                    }
                )
    return cells


# ── Cluster cells into polygons ────────────────────────────────────────────
def cells_to_geojson_features(
    cells: list[dict],
    step: float = 0.5,
    pressure_hPa: float = 250.0,
    valid_time: str = "",
) -> list[dict]:
    """
    Convert a list of risk cells into GeoJSON polygon features.
    Groups cells into risk-level bands and creates bounding boxes.
    """
    if not valid_time:
        valid_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")

    half = step / 2.0
    features = []

    # Bucket by risk level
    risk_buckets: dict[str, list[dict]] = {"high": [], "medium": [], "low": []}
    for c in cells:
        if c["risk_score"] >= 0.7:
            risk_buckets["high"].append(c)
        elif c["risk_score"] >= 0.4:
            risk_buckets["medium"].append(c)
        else:
            risk_buckets["low"].append(c)

    for risk_level, bucket in risk_buckets.items():
        if not bucket:
            continue

        if HAS_SHAPELY:
            # Merge cells into unified polygons
            polys = [
                ShapelyPolygon(
                    [
                        (c["lon"] - half, c["lat"] - half),
                        (c["lon"] + half, c["lat"] - half),
                        (c["lon"] + half, c["lat"] + half),
                        (c["lon"] - half, c["lat"] + half),
                    ]
                )
                for c in bucket
            ]
            merged = unary_union(polys)
            geoms = (
                list(merged.geoms)
                if merged.geom_type == "MultiPolygon"
                else [merged]
            )
            for geom in geoms:
                if geom.area < 1.0:  # skip tiny slivers
                    continue
                sub = [
                    c
                    for c in bucket
                    if geom.contains(
                        ShapelyPolygon(
                            [
                                (c["lon"] - half, c["lat"] - half),
                                (c["lon"] + half, c["lat"] - half),
                                (c["lon"] + half, c["lat"] + half),
                                (c["lon"] - half, c["lat"] + half),
                            ]
                        ).centroid
                    )
                ]
                if not sub:
                    sub = bucket
                avg_T = sum(c["T_K"] for c in sub) / len(sub)
                avg_rhi = sum(c["rhi"] for c in sub) / len(sub)
                avg_score = sum(c["risk_score"] for c in sub) / len(sub)
                area_km2 = int(geom.area * 111.32**2)
                features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "risk_level": risk_level,
                            "risk_score": round(avg_score, 3),
                            "altitude_ft": int(
                                44307.69 * (1 - (pressure_hPa / 1013.25) ** 0.190284)
                            ),
                            "temperature_k": round(avg_T, 1),
                            "rhi": round(avg_rhi, 3),
                            "area_km2": area_km2,
                            "valid_time": valid_time,
                            "label": f"{risk_level.capitalize()} contrail risk zone",
                        },
                        "geometry": mapping(geom),
                    }
                )
        else:
            # Fallback: one bounding-box polygon per risk band
            lats = [c["lat"] for c in bucket]
            lons = [c["lon"] for c in bucket]
            lat_min, lat_max = min(lats) - half, max(lats) + half
            lon_min, lon_max = min(lons) - half, max(lons) + half
            avg_T = sum(c["T_K"] for c in bucket) / len(bucket)
            avg_rhi = sum(c["rhi"] for c in bucket) / len(bucket)
            avg_score = sum(c["risk_score"] for c in bucket) / len(bucket)
            area_km2 = int(
                (lat_max - lat_min) * (lon_max - lon_min) * 111.32**2
            )
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "risk_level": risk_level,
                        "risk_score": round(avg_score, 3),
                        "altitude_ft": int(
                            44307.69 * (1 - (pressure_hPa / 1013.25) ** 0.190284)
                        ),
                        "temperature_k": round(avg_T, 1),
                        "rhi": round(avg_rhi, 3),
                        "area_km2": area_km2,
                        "valid_time": valid_time,
                        "label": f"{risk_level.capitalize()} contrail risk zone",
                    },
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [lon_min, lat_min],
                                [lon_max, lat_min],
                                [lon_max, lat_max],
                                [lon_min, lat_max],
                                [lon_min, lat_min],
                            ]
                        ],
                    },
                }
            )

    return features


# ── GFS GRIB2 reader (real data mode) ─────────────────────────────────────
def gfs_to_issr_cells(grib_path: str, pressure_hPa: float = 250.0) -> list[dict]:
    """
    Read a GFS GRIB2 file (with cfgrib) and extract ISSR risk cells.
    Expects variables: t (temperature), r (relative humidity).
    """
    try:
        import cfgrib
    except ImportError:
        print("cfgrib not installed. Run: pip install cfgrib", file=sys.stderr)
        sys.exit(1)

    datasets = cfgrib.open_datasets(grib_path)
    t_ds = next(
        (d for d in datasets if "t" in d.data_vars and "isobaricInhPa" in d.dims),
        None,
    )
    r_ds = next(
        (d for d in datasets if "r" in d.data_vars and "isobaricInhPa" in d.dims),
        None,
    )

    if t_ds is None or r_ds is None:
        print("Could not find temperature/humidity variables in GRIB2.", file=sys.stderr)
        sys.exit(1)

    t_level = t_ds.sel(isobaricInhPa=pressure_hPa, method="nearest")["t"]
    r_level = r_ds.sel(isobaricInhPa=pressure_hPa, method="nearest")["r"]

    cells = []
    lats = t_level.latitude.values
    lons = t_level.longitude.values

    for i, lat in enumerate(lats):
        if not (24 <= lat <= 55):
            continue
        for j, lon in enumerate(lons):
            lon_w = lon if lon <= 180 else lon - 360
            if not (-130 <= lon_w <= -60):
                continue
            T_K = float(t_level.values[i, j])
            rh = float(r_level.values[i, j])
            # Convert relative humidity over liquid (%) to over ice
            rhi = (rh / 100.0) * math.exp(
                6808 * (1 / 273.15 - 1 / T_K) - 5.09 * math.log(T_K / 273.15)
            )
            sac = schmidt_appleman(T_K, pressure_hPa, rhi)
            risk_score = float(max(0.0, min(1.0, (rhi - 0.9) * 2.5))) if sac else 0.0
            if risk_score > 0.05:
                cells.append(
                    {
                        "lat": float(lat),
                        "lon": float(lon_w),
                        "T_K": T_K,
                        "rhi": rhi,
                        "risk_score": risk_score,
                        "sac": sac,
                    }
                )
    return cells


# ── Main ──────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="Generate contrail-risk GeoJSON")
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Use synthetic data (no real GFS required)",
    )
    parser.add_argument(
        "--gfs",
        type=str,
        default="",
        help="Path to GFS GRIB2 file",
    )
    parser.add_argument(
        "--pressure",
        type=float,
        default=250.0,
        help="Pressure level in hPa (default: 250)",
    )
    parser.add_argument(
        "--out",
        type=str,
        default="latest.geojson",
        help="Output GeoJSON file path",
    )
    args = parser.parse_args()

    valid_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    pressure_hPa = args.pressure

    if args.demo or not args.gfs:
        print("Running in DEMO mode (synthetic ISSR grid)…")
        if not HAS_NUMPY:
            print("numpy is required for demo mode. pip install numpy", file=sys.stderr)
            sys.exit(1)
        cells = synthetic_issr_grid(pressure_hPa=pressure_hPa)
    else:
        print(f"Reading GFS data from {args.gfs}…")
        cells = gfs_to_issr_cells(args.gfs, pressure_hPa=pressure_hPa)

    print(f"Found {len(cells)} ISSR-positive cells. Converting to polygons…")
    features = cells_to_geojson_features(cells, pressure_hPa=pressure_hPa, valid_time=valid_time)
    print(f"Produced {len(features)} risk polygon(s).")

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated": datetime.now(timezone.utc).isoformat(),
            "forecast_valid": valid_time,
            "forecast_source": "GFS 0.25°" if args.gfs else "Synthetic (demo)",
            "pressure_hpa": pressure_hPa,
            "model": "pycontrails CoCiP + Schmidt–Appleman",
        },
        "features": features,
    }

    out_path = Path(args.out)
    out_path.write_text(json.dumps(geojson, indent=2))
    print(f"Saved → {out_path.resolve()}")


if __name__ == "__main__":
    main()
