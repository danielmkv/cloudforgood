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
    """Return (score, lats, lons) for the chosen pressure level.
    Score: 0=no contrail, 0.5=short, 1.0=persistent."""

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
    r = ds_r["r"].sel(isobaricInhPa=pressure_level).values  # percent (over water)
    lats = ds_t["latitude"].values
    lons = ds_t["longitude"].values

    # Saturation vapor pressures (Pa)
    e_sat_ice = 611.21 * np.exp(22.587 * (t - 273.15) / (t - 0.7))
    e_sat_water = 611.21 * np.exp(17.502 * (t - 273.15) / (t - 32.18))

    # Convert RH (over water) -> RH (over ice)
    rh_ice = (r / 100.0) * (e_sat_water / e_sat_ice)

    # Score
    cold_enough = t < 233.0
    persistent = rh_ice > 1.0
    score = np.zeros_like(t, dtype=np.float32)
    score[cold_enough] = 0.5
    score[cold_enough & persistent] = 1.0

    print(f"  Persistent contrail pixels: {(score == 1.0).sum():,}")
    print(f"  Short contrail pixels: {(score == 0.5).sum():,}")

    return score, lats, lons


def score_to_geojson(score, lats, lons, simplify_tolerance=0.5):
    """Convert score raster to GeoJSON polygons.
    simplify_tolerance: degrees, larger = fewer vertices."""

    print("Building polygons...")

    # GFS longitudes go 0-360. Convert to -180..180 for standard GeoJSON.
    lons_180 = np.where(lons > 180, lons - 360, lons)

    # rasterio.features.shapes needs a 2D uint8 array + an affine transform.
    # Build transform from lat/lon grid (0.25 deg resolution).
    from rasterio.transform import from_bounds
    height, width = score.shape
    transform = from_bounds(
        west=lons_180.min(),
        south=lats.min(),
        east=lons_180.max(),
        north=lats.max(),
        width=width,
        height=height,
    )

    # GFS data is north-to-south in latitudes; rasterio expects top-to-bottom.
    # If lats[0] > lats[-1] (north first), we're good. Otherwise flip.
    if lats[0] < lats[-1]:
        score = score[::-1, :]

    # Roll longitudes so the array goes -180 to 180 instead of 0 to 360
    if lons.max() > 180:
        split_idx = np.searchsorted(lons, 180)
        score = np.concatenate([score[:, split_idx:], score[:, :split_idx]], axis=1)

    features = []
    for level_value in [0.5, 1.0]:
        mask = (score == level_value).astype(np.uint8)
        if mask.sum() == 0:
            continue

        for geom_dict, val in rasterio.features.shapes(mask, mask=mask > 0, transform=transform):
            poly = shape(geom_dict)
            if not poly.is_valid:
                poly = poly.buffer(0)
            poly = poly.simplify(simplify_tolerance, preserve_topology=True)
            if poly.is_empty:
                continue

            features.append({
                "type": "Feature",
                "geometry": mapping(poly),
                "properties": {
                    "intensity": float(level_value),
                    "label": "persistent" if level_value == 1.0 else "short",
                },
            })

    geojson = {"type": "FeatureCollection", "features": features}
    print(f"  Total features: {len(features)}")
    return geojson


def main(grib_path, output_path):
    score, lats, lons = compute_contrail_score(grib_path)
    geojson = score_to_geojson(score, lats, lons)

    with open(output_path, "w") as f:
        json.dump(geojson, f)

    print(f"Wrote {output_path}")
    print(f"\nTo view: upload {output_path} to https://geojson.io")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python predict_local.py <grib_file> <output.geojson>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
