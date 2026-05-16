"""
Lambda: predict  (container image)
===================================
Triggered by S3 ObjectCreated on s3://contrai-input-711726113023-us-east-1-an/runs/*.grib2

Reads a GFS GRIB2 file, computes contrail-favorable regions using the
Schmidt–Appleman criterion + ice supersaturation check, vectorises the
score raster with rasterio (same algorithm as prediction_local/predict_local.py),
and writes enriched GeoJSON to the output bucket.

Environment variables:
    S3_SRC_BUCKET    — input bucket  (default: contrai-input-711726113023-us-east-1-an)
    S3_DST_BUCKET    — output bucket (default: contrai-contrails)
    PRESSURE_LEVEL   — hPa level     (default: 250)
    CLOUDFRONT_DIST_ID — optional, triggers /latest.geojson invalidation
"""

import json
import logging
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import boto3
import numpy as np
import xarray as xr

logger = logging.getLogger()
logger.setLevel(logging.INFO)

S3_SRC_BUCKET = os.environ.get("S3_SRC_BUCKET", "contrai-input-711726113023-us-east-1-an")
S3_DST_BUCKET = os.environ.get("S3_DST_BUCKET", "contrai-contrails")
PRESSURE_HPA = float(os.environ.get("PRESSURE_LEVEL", "250"))
CF_DIST_ID = os.environ.get("CLOUDFRONT_DIST_ID", "")


# ── Physics helpers ────────────────────────────────────────────────────────

def compute_contrail_score(t: np.ndarray, r: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Continuous contrail risk score in [0, 1] — matches prediction_local/predict_local.py.

      cold_factor = clip((233 - T) / 20, 0, 1)   — 0 at SAC threshold, 1 at ~213 K
      rhi_factor  = clip((RHi - 0.7) / 0.6, 0, 1) — 0 at dry, 1 at strongly supersaturated
      score       = cold_factor × rhi_factor        (only where T < 233 K)

    t: temperature (K), r: relative humidity over water (%)
    """
    e_sat_ice   = 611.21 * np.exp(22.587 * (t - 273.15) / (t - 0.7))
    e_sat_water = 611.21 * np.exp(17.502 * (t - 273.15) / (t - 32.18))
    rh_ice = (r / 100.0) * (e_sat_water / e_sat_ice)

    cold_factor = np.clip((233.0 - t) / 20.0, 0.0, 1.0)
    rhi_factor  = np.clip((rh_ice - 0.7) / 0.6, 0.0, 1.0)
    score = np.where(t < 233.0, cold_factor * rhi_factor, 0.0).astype(np.float32)
    return score, rh_ice


def altitude_ft_from_hpa(p: float) -> int:
    return int(44307.69 * (1.0 - (p / 1013.25) ** 0.190284))


# ── Rasterio vectorisation (mirrors predict_local.py) ─────────────────────

def score_to_features(
    score: np.ndarray,
    rh_ice: np.ndarray,
    t: np.ndarray,
    lats: np.ndarray,
    lons: np.ndarray,
    valid_time: str,
    simplify_tolerance: float = 0.5,
) -> list[dict]:
    import rasterio.features
    from rasterio.transform import from_bounds
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union

    # Convert 0-360 longitude to -180..180
    lons_180 = np.where(lons > 180, lons - 360, lons)

    height, width = score.shape
    transform = from_bounds(
        west=lons_180.min(), south=lats.min(),
        east=lons_180.max(), north=lats.max(),
        width=width, height=height,
    )

    # GFS latitude ordering: if north-first, rasterio is happy; else flip
    work_score = score.copy()
    work_t     = t.copy()
    work_rhi   = rh_ice.copy()
    if lats[0] < lats[-1]:
        work_score = work_score[::-1, :]
        work_t     = work_t[::-1, :]
        work_rhi   = work_rhi[::-1, :]

    # Reorder longitudes from 0-360 to -180..180
    if lons.max() > 180:
        split = np.searchsorted(lons, 180)
        work_score = np.concatenate([work_score[:, split:], work_score[:, :split]], axis=1)
        work_t     = np.concatenate([work_t[:, split:],     work_t[:, :split]],     axis=1)
        work_rhi   = np.concatenate([work_rhi[:, split:],   work_rhi[:, :split]],   axis=1)

    THRESHOLD = 0.05
    altitude_ft = altitude_ft_from_hpa(PRESSURE_HPA)
    features = []

    # Single mask: any pixel above threshold gets a polygon shape
    mask = (work_score > THRESHOLD).astype(np.uint8)

    for geom_dict, _ in rasterio.features.shapes(mask, mask=mask, transform=transform):
        poly = shape(geom_dict)
        if not poly.is_valid:
            poly = poly.buffer(0)
        poly = poly.simplify(simplify_tolerance, preserve_topology=True)
        if poly.is_empty or poly.area < 0.01:
            continue

        # Sample continuous score from pixels in this polygon's bbox
        bounds = poly.bounds
        lon_mask = (lons_180 >= bounds[0]) & (lons_180 <= bounds[2])
        lat_mask = (lats     >= bounds[1]) & (lats     <= bounds[3])
        region_score = score[np.ix_(lat_mask, lon_mask)] if lat_mask.any() and lon_mask.any() else np.array([])
        region_rhi   = rh_ice[np.ix_(lat_mask, lon_mask)] if lat_mask.any() and lon_mask.any() else np.array([])
        region_t     = t[np.ix_(lat_mask, lon_mask)] if lat_mask.any() and lon_mask.any() else np.array([])

        active = region_score[region_score > THRESHOLD]
        mean_score = float(active.mean()) if active.size > 0 else float(score[score > THRESHOLD].mean())
        avg_rhi    = float(region_rhi.mean()) if region_rhi.size > 0 else float(rh_ice.mean())
        avg_T      = float(region_t.mean())   if region_t.size   > 0 else float(t.mean())

        # Derive categorical label from continuous score
        if mean_score >= 0.6:
            label, risk_level, intensity = "persistent", "high",   1.0
        elif mean_score >= 0.3:
            label, risk_level, intensity = "persistent", "medium", 0.7
        else:
            label, risk_level, intensity = "short",      "low",    0.5

        features.append({
            "type": "Feature",
            "geometry": mapping(poly),
            "properties": {
                "intensity":     round(intensity, 2),
                "label":         label,
                "risk_level":    risk_level,
                "risk_score":    round(mean_score, 3),
                "altitude_ft":   altitude_ft,
                "temperature_k": round(avg_T, 1),
                "rhi":           round(avg_rhi, 3),
                "area_km2":      int(poly.area * 111.32 ** 2),
                "valid_time":    valid_time,
            },
        })

    logger.info("Vectorised %d features (0.5: short-lived, 1.0: persistent)", len(features))
    return features


# ── Lambda entry point ────────────────────────────────────────────────────

def lambda_handler(event: dict, context: object) -> dict:
    logger.info("Predict Lambda invoked. Event: %s", json.dumps(event))
    s3 = boto3.client("s3")

    # ── Parse S3 trigger ─────────────────────────────────────────────────
    record  = event["Records"][0]["s3"]
    src_key = record["object"]["key"]   # e.g. runs/20260516T12.grib2
    logger.info("Processing s3://%s/%s", S3_SRC_BUCKET, src_key)

    # Derive run ID from key: runs/20260516T12.grib2 → 20260516T12
    run_id = Path(src_key).stem           # "20260516T12"
    valid_time = datetime.now(timezone.utc).isoformat()

    # ── Download GRIB2 ───────────────────────────────────────────────────
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        tmp_path = tmp.name
    logger.info("Downloading to %s", tmp_path)
    s3.download_file(S3_SRC_BUCKET, src_key, tmp_path)

    try:
        # ── Read GFS with cfgrib ──────────────────────────────────────────
        logger.info("Reading GFS GRIB2 at %s hPa…", PRESSURE_HPA)
        ds_t = xr.open_dataset(
            tmp_path, engine="cfgrib",
            filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "t"},
        )
        ds_r = xr.open_dataset(
            tmp_path, engine="cfgrib",
            filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "r"},
        )

        t_arr   = ds_t["t"].sel(isobaricInhPa=PRESSURE_HPA).values
        r_arr   = ds_r["r"].sel(isobaricInhPa=PRESSURE_HPA).values
        lats    = ds_t["latitude"].values
        lons    = ds_t["longitude"].values

        logger.info("Grid: %s, T range %.1f–%.1f K", t_arr.shape, t_arr.min(), t_arr.max())

        # ── Score + vectorise ─────────────────────────────────────────────
        score, rh_ice = compute_contrail_score(t_arr, r_arr)
        logger.info("Persistent pixels: %d, short: %d",
                    (score == 1.0).sum(), (score == 0.5).sum())

        features = score_to_features(score, rh_ice, t_arr, lats, lons, valid_time)

    finally:
        Path(tmp_path).unlink(missing_ok=True)

    # ── Build GeoJSON ─────────────────────────────────────────────────────
    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated":       datetime.now(timezone.utc).isoformat(),
            "forecast_valid":  valid_time,
            "forecast_source": "GFS 0.25°",
            "pressure_hpa":    PRESSURE_HPA,
            "model":           "Schmidt–Appleman + ISSR (predict_local algorithm)",
            "run_id":          run_id,
        },
        "features": features,
    }
    body = json.dumps(geojson)

    # ── Write run-specific output ──────────────────────────────────────────
    run_key = f"runs/{run_id}/contrails.geojson"
    s3.put_object(
        Bucket=S3_DST_BUCKET, Key=run_key,
        Body=body, ContentType="application/geo+json",
        CacheControl="max-age=21600",
    )
    logger.info("Wrote s3://%s/%s", S3_DST_BUCKET, run_key)

    # ── Overwrite latest.geojson ──────────────────────────────────────────
    s3.put_object(
        Bucket=S3_DST_BUCKET, Key="latest.geojson",
        Body=body, ContentType="application/geo+json",
        CacheControl="max-age=300",
    )
    logger.info("Updated latest.geojson")

    # ── CloudFront invalidation ───────────────────────────────────────────
    if CF_DIST_ID:
        boto3.client("cloudfront").create_invalidation(
            DistributionId=CF_DIST_ID,
            InvalidationBatch={
                "Paths": {"Quantity": 1, "Items": ["/latest.geojson"]},
                "CallerReference": run_id,
            },
        )
        logger.info("CloudFront invalidation requested.")

    return {
        "statusCode": 200,
        "run_id": run_id,
        "feature_count": len(features),
        "output_key": run_key,
    }


# Alias so both handler.handler and handler.lambda_handler work
handler = lambda_handler
