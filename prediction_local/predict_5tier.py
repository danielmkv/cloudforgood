"""
Predict contrail-favorable regions with continuous scoring (5 tiers).

Usage:
    python predict_5tier.py gfs.t12z.pgrb2.0p25.f000 output.geojson

Outputs polygons at 5 intensity levels: 0.1, 0.25, 0.4, 0.6, 0.8.
Rendered as nested layers, gives a purple-to-red heatmap effect.
"""

import sys
import json
import numpy as np
import xarray as xr
from scipy.ndimage import gaussian_filter
from shapely.geometry import shape, mapping
import rasterio.features
from rasterio.transform import from_bounds


def compute_score(grib_path, pressure_level=250):
    """Continuous contrail-favorability score, 0 to 1."""
    ds_t = xr.open_dataset(
        grib_path, engine="cfgrib",
        filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "t"},
    )
    ds_r = xr.open_dataset(
        grib_path, engine="cfgrib",
        filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "r"},
    )

    t = ds_t["t"].sel(isobaricInhPa=pressure_level).values
    r = ds_r["r"].sel(isobaricInhPa=pressure_level).values
    lats = ds_t["latitude"].values
    lons = ds_t["longitude"].values

    # Saturation vapor pressures (Pa)
    e_sat_ice = 611.21 * np.exp(22.587 * (t - 273.15) / (t - 0.7))
    e_sat_water = 611.21 * np.exp(17.502 * (t - 273.15) / (t - 32.18))
    rh_ice = (r / 100.0) * (e_sat_water / e_sat_ice)

    # Continuous score: combines temperature margin + ice supersaturation
    t_margin = np.clip((233.0 - t) / 30.0, 0, 1)   # 0 at threshold, 1 deeply cold
    rh_factor = np.clip(rh_ice / 1.2, 0, 1)         # 0 dry, 1 strongly supersaturated
    cold = t < 233.0
    score = np.where(cold, t_margin * rh_factor, 0.0).astype(np.float32)
    score = gaussian_filter(score, sigma=1.5)

    return score, lats, lons


def score_to_geojson(score, lats, lons, simplify=0.2):
    """Polygonize at 5 intensity thresholds."""
    lons_180 = np.where(lons > 180, lons - 360, lons)
    height, width = score.shape
    transform = from_bounds(
        west=float(lons_180.min()), south=float(lats.min()),
        east=float(lons_180.max()), north=float(lats.max()),
        width=width, height=height,
    )

    if lats[0] < lats[-1]:
        score = score[::-1, :]

    if lons.max() > 180:
        split_idx = np.searchsorted(lons, 180)
        score = np.concatenate([score[:, split_idx:], score[:, :split_idx]], axis=1)

    # 5 nested intensity tiers
    thresholds = [0.1, 0.25, 0.4, 0.6, 0.8]
    features = []

    for thr in thresholds:
        mask = (score >= thr).astype(np.uint8)
        if mask.sum() == 0:
            continue
        n_polys = 0
        for geom, _ in rasterio.features.shapes(mask, mask=mask > 0, transform=transform):
            poly = shape(geom)
            if not poly.is_valid:
                poly = poly.buffer(0)
            poly = poly.simplify(simplify, preserve_topology=True)
            if poly.is_empty:
                continue
            features.append({
                "type": "Feature",
                "geometry": mapping(poly),
                "properties": {"intensity": float(thr)},
            })
            n_polys += 1
        print(f"  threshold {thr}: {n_polys} polygons")

    return {"type": "FeatureCollection", "features": features}


def main(grib_path, out_path):
    print(f"Computing score from {grib_path}...")
    score, lats, lons = compute_score(grib_path)
    print(f"  Score range: {score.min():.3f} to {score.max():.3f}")
    print(f"  Mean (nonzero): {score[score > 0].mean():.3f}")
    print(f"  Nonzero pixels: {(score > 0).sum():,}")

    print("Polygonizing...")
    geojson = score_to_geojson(score, lats, lons)
    print(f"Total features: {len(geojson['features'])}")

    with open(out_path, "w") as f:
        json.dump(geojson, f)
    print(f"\nWrote {out_path}")
    print(f"Test at https://geojson.io")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python predict_5tier.py <grib_file> <output.geojson>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])