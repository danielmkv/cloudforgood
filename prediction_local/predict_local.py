"""
Predict contrail-favorable regions from GFS data, output as GeoJSON.

Usage:
    python predict_local.py gfs.t12z.pgrb2.0p25.f000 output.geojson

This is the local-only version. Reads a GRIB2 file, writes a GeoJSON file.
Once this works, we'll wrap it for Lambda (S3 in, S3 out).

Install once:
    pip install cfgrib xarray numpy shapely rasterio
"""

import sys
import json
import numpy as np
import xarray as xr
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
import rasterio.features


def compute_contrail_score(grib_path, pressure_level=250):
    """
    Return (score, rh_ice, lats, lons) for the chosen pressure level.

    score is now a CONTINUOUS value in [0, 1] — not binary — built from
    two physically-grounded factors:

      cold_factor  = clip((233 - T) / 20, 0, 1)
                     0 at the SAC threshold (233 K), 1 at very cold cruise air (~213 K)

      rhi_factor   = clip((RHi - 0.7) / 0.6, 0, 1)
                     0 at dry conditions (RHi = 0.7),
                     0.5 at saturation (RHi = 1.0, contrail just persists),
                     1.0 at strongly supersaturated (RHi = 1.3+)

      score = cold_factor × rhi_factor
              (both conditions must be met; product ensures they compound)

    This maps naturally to the rainbow: blue (low, barely possible) through
    green/yellow (moderate, short-lived) to orange/red (high, strongly persistent).
    """
    print(f"Opening {grib_path}...")

    ds_t = xr.open_dataset(
        grib_path,
        engine="cfgrib",
        filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "t"},
    )
    ds_r = xr.open_dataset(
        grib_path,
        engine="cfgrib",
        filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "r"},
    )

    t = ds_t["t"].sel(isobaricInhPa=pressure_level).values  # Kelvin
    r = ds_r["r"].sel(isobaricInhPa=pressure_level).values  # % over water
    lats = ds_t["latitude"].values
    lons = ds_t["longitude"].values

    # Saturation vapor pressures (Pa) — Magnus–Tetens
    e_sat_ice   = 611.21 * np.exp(22.587 * (t - 273.15) / (t - 0.7))
    e_sat_water = 611.21 * np.exp(17.502 * (t - 273.15) / (t - 32.18))

    # RH over water → RH over ice
    rh_ice = (r / 100.0) * (e_sat_water / e_sat_ice)

    # Continuous factors
    cold_factor = np.clip((233.0 - t) / 20.0, 0.0, 1.0)   # 0 at 233 K, 1 at 213 K
    rhi_factor  = np.clip((rh_ice - 0.7) / 0.6, 0.0, 1.0)  # 0 at 0.7, 1 at 1.3+

    # Only score where the SAC necessary condition is met (T < 233 K)
    score = np.where(t < 233.0, cold_factor * rhi_factor, 0.0).astype(np.float32)

    print(f"  Score range: {score[score > 0].min():.3f} – {score.max():.3f}")
    print(f"  Pixels with any risk (score > 0.05): {(score > 0.05).sum():,}")
    print(f"  High risk pixels (score > 0.7):      {(score > 0.70).sum():,}")

    return score, rh_ice, lats, lons


def score_to_geojson(score, rh_ice, lats, lons, simplify_tolerance=0.15, threshold=0.05):
    """
    Convert continuous score raster to GeoJSON polygons.

    Each polygon's risk_score is the mean continuous score of pixels inside it,
    NOT a binary bin — so the rainbow spans the full 0→1 range.
    """
    print("Building polygons...")

    lons_180 = np.where(lons > 180, lons - 360, lons)

    from rasterio.transform import from_bounds
    height, width = score.shape
    transform = from_bounds(
        west=lons_180.min(), south=lats.min(),
        east=lons_180.max(), north=lats.max(),
        width=width, height=height,
    )

    # Align grid orientation
    work_score = score.copy()
    work_rhi   = rh_ice.copy()
    if lats[0] < lats[-1]:
        work_score = work_score[::-1, :]
        work_rhi   = work_rhi[::-1, :]

    if lons.max() > 180:
        split_idx = np.searchsorted(lons, 180)
        work_score = np.concatenate([work_score[:, split_idx:], work_score[:, :split_idx]], axis=1)
        work_rhi   = np.concatenate([work_rhi[:, split_idx:],   work_rhi[:, :split_idx]],   axis=1)

    # Single binary mask: any pixel with score > threshold gets a polygon
    mask = (work_score > threshold).astype(np.uint8)

    features = []
    for geom_dict, _ in rasterio.features.shapes(mask, mask=mask, transform=transform):
        poly = shape(geom_dict)
        if not poly.is_valid:
            poly = poly.buffer(0)
        poly = poly.simplify(simplify_tolerance, preserve_topology=True)
        if poly.is_empty or poly.area * 111.32 ** 2 < 400:  # skip < ~400 km² (1-2 pixel noise)
            continue

        # Sample pixels inside this polygon's bounding box to get mean score
        bounds = poly.bounds  # (minx, miny, maxx, maxy) in lon/lat
        col_mask = (lons_180 >= bounds[0]) & (lons_180 <= bounds[2])
        row_mask = (lats    >= bounds[1]) & (lats    <= bounds[3])
        region_score = score[np.ix_(row_mask, col_mask)] if row_mask.any() and col_mask.any() else np.array([])
        region_rhi   = rh_ice[np.ix_(row_mask, col_mask)] if row_mask.any() and col_mask.any() else np.array([])

        mean_score = float(region_score[region_score > threshold].mean()) \
                     if region_score.size > 0 and (region_score > threshold).any() \
                     else float(score[score > threshold].mean())
        mean_rhi   = float(region_rhi.mean()) if region_rhi.size > 0 else 0.0

        # Derive categorical label from continuous score
        if mean_score >= 0.6:
            label, risk_level, intensity = "persistent", "high",   1.0
        elif mean_score >= 0.3:
            label, risk_level, intensity = "persistent", "medium",  0.7
        else:
            label, risk_level, intensity = "short",      "low",    0.5

        features.append({
            "type": "Feature",
            "geometry": mapping(poly),
            "properties": {
                "intensity":   round(intensity, 2),
                "label":       label,
                "risk_level":  risk_level,
                "risk_score":  round(mean_score, 3),
                "rhi":         round(mean_rhi, 3),
                "altitude_ft": int(44307.69 * (1.0 - (pressure_level / 1013.25) ** 0.190284) * 3.28084),
                "area_km2":    int(poly.area * 111.32 ** 2),
            },
        })

    print(f"  Total features: {len(features)}")
    score_vals = [f["properties"]["risk_score"] for f in features]
    if score_vals:
        print(f"  Risk score range: {min(score_vals):.3f} – {max(score_vals):.3f}")
    return {"type": "FeatureCollection", "features": features}


def main(grib_path, output_path):
    score, rh_ice, lats, lons = compute_contrail_score(grib_path)
    geojson = score_to_geojson(score, rh_ice, lats, lons)

    with open(output_path, "w") as f:
        json.dump(geojson, f)

    print(f"Wrote {output_path}")
    print(f"\nTo view: upload {output_path} to https://geojson.io")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python predict_local.py <grib_file> <output.geojson>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
