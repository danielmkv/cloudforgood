"""
lambda-predict: triggered by S3 event when a new GRIB2 lands in contrai-input.
Reads the GRIB2, computes contrail-favorable regions with continuous scoring,
polygonizes at 5 intensity tiers, writes GeoJSON to contrai-contrails.
"""

import os
import json
import boto3
import numpy as np
import xarray as xr
from scipy.ndimage import gaussian_filter
from shapely.geometry import shape, mapping
import rasterio.features
from rasterio.transform import from_bounds


OUTPUT_BUCKET = "contrai-contrails-711726113023-us-east-1-an"
PRESSURE_LEVEL = 250  # hPa, ~34,000 ft cruise altitude

s3 = boto3.client("s3")


def compute_contrail_score(grib_path):
    """Return (score, lats, lons) where score is continuous 0..1.
    Combines temperature margin below SAC threshold with ice supersaturation."""
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

    t = ds_t["t"].sel(isobaricInhPa=PRESSURE_LEVEL).values
    r = ds_r["r"].sel(isobaricInhPa=PRESSURE_LEVEL).values
    lats = ds_t["latitude"].values
    lons = ds_t["longitude"].values

    # Saturation vapor pressures (Pa), Magnus-Tetens formulas
    e_sat_ice = 611.21 * np.exp(22.587 * (t - 273.15) / (t - 0.7))
    e_sat_water = 611.21 * np.exp(17.502 * (t - 273.15) / (t - 32.18))

    # Convert RH (over water) -> RH (over ice)
    rh_ice = (r / 100.0) * (e_sat_water / e_sat_ice)

    # Continuous favorability score, combining:
    # - temperature margin below SAC threshold (-40C), scaled 0..1
    # - ice supersaturation factor, scaled 0..1
    t_margin = np.clip((233.0 - t) / 30.0, 0, 1)
    rh_factor = np.clip(rh_ice / 1.2, 0, 1)
    cold = t < 233.0
    score = np.where(cold, t_margin * rh_factor, 0.0).astype(np.float32)
    score = gaussian_filter(score, sigma=1.5)

    return score, lats, lons


def score_to_geojson(score, lats, lons, simplify=0.2):
    """Polygonize the score raster at 5 intensity thresholds for a nested gradient."""
    lons_180 = np.where(lons > 180, lons - 360, lons)

    height, width = score.shape
    transform = from_bounds(
        west=float(lons_180.min()), south=float(lats.min()),
        east=float(lons_180.max()), north=float(lats.max()),
        width=width, height=height,
    )

    # Normalize orientation: north-to-south, -180 to 180
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


def lambda_handler(event, context):
    record = event["Records"][0]
    src_bucket = record["s3"]["bucket"]["name"]
    src_key = record["s3"]["object"]["key"]

    print(f"Triggered by s3://{src_bucket}/{src_key}")

    grib_path = f"/tmp/{os.path.basename(src_key)}"
    print(f"Downloading to {grib_path}...")
    s3.download_file(src_bucket, src_key, grib_path)

    print("Computing contrail score (continuous)...")
    score, lats, lons = compute_contrail_score(grib_path)
    print(f"  Score range: {score.min():.3f} to {score.max():.3f}")
    print(f"  Nonzero pixels: {(score > 0).sum():,}")

    print("Polygonizing at 5 tiers...")
    geojson = score_to_geojson(score, lats, lons)
    print(f"  Total features: {len(geojson['features'])}")

    timestamp = os.path.basename(src_key).replace(".grib2", "")
    out_key = f"scenes/{timestamp}.geojson"
    body = json.dumps(geojson)

    print(f"Writing s3://{OUTPUT_BUCKET}/{out_key}")
    s3.put_object(
        Bucket=OUTPUT_BUCKET,
        Key=out_key,
        Body=body,
        ContentType="application/json",
    )

    s3.put_object(
        Bucket=OUTPUT_BUCKET,
        Key="latest.geojson",
        Body=body,
        ContentType="application/json",
        CacheControl="no-cache",
    )

    os.remove(grib_path)

    return {
        "statusCode": 200,
        "body": json.dumps({
            "scene": out_key,
            "features": len(geojson["features"]),
        }),
    }