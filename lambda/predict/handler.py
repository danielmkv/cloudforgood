"""
Lambda: predict  (container image — pycontrails + cfgrib)
==========================================================
Triggered by S3 ObjectCreated event on:
    s3://contrai-input/scenes/<scene_id>/manifest.json

Reads the GFS GRIB2 file at the path in the manifest, runs the
Schmidt–Appleman criterion + ISSR check at 250 hPa over North America,
clusters the positive cells into GeoJSON polygons, and writes:
    s3://contrai-contrails/scenes/<scene_id>/contrails.geojson
    s3://contrai-contrails/latest.geojson   (overwrite — always current)

Environment variables:
    INPUT_BUCKET   — source bucket   (e.g. "contrai-input")
    OUTPUT_BUCKET  — output bucket   (e.g. "contrai-contrails")
    PRESSURE_LEVEL — hPa level       (default: "250")
    CLOUDFRONT_DIST_ID — (optional) CloudFront distribution ID to invalidate
"""

import json
import logging
import math
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

INPUT_BUCKET = os.environ.get("INPUT_BUCKET", "contrai-input")
OUTPUT_BUCKET = os.environ.get("OUTPUT_BUCKET", "contrai-contrails")
PRESSURE_HPA = float(os.environ.get("PRESSURE_LEVEL", "250"))
CF_DIST_ID = os.environ.get("CLOUDFRONT_DIST_ID", "")


# ── Schmidt–Appleman criterion ────────────────────────────────────────────
def schmidt_appleman(T_K: float, p_hPa: float, rhi: float) -> bool:
    T_LC = 226.69 + 9.43 * math.log(max(p_hPa, 1e-6) / 1000) + 0.114 * (p_hPa / 1000)
    return T_K < T_LC and rhi > 1.0


# ── RH over liquid → RHi conversion ──────────────────────────────────────
def rhl_to_rhi(rhl_pct: float, T_K: float) -> float:
    """Convert relative humidity over liquid water (%) to over ice (fraction)."""
    return (rhl_pct / 100.0) * math.exp(
        6808.0 * (1.0 / 273.15 - 1.0 / max(T_K, 100.0))
        - 5.09 * math.log(T_K / 273.15)
    )


# ── Parse GFS GRIB2 with cfgrib ───────────────────────────────────────────
def extract_issr_cells(grib_path: str) -> list[dict]:
    import cfgrib  # type: ignore
    import numpy as np

    logger.info("Opening GRIB2: %s", grib_path)
    datasets = cfgrib.open_datasets(grib_path, backend_kwargs={"indexing_time": None})

    t_ds = next(
        (d for d in datasets if "t" in d.data_vars and "isobaricInhPa" in d.dims), None
    )
    r_ds = next(
        (d for d in datasets if "r" in d.data_vars and "isobaricInhPa" in d.dims), None
    )

    if t_ds is None or r_ds is None:
        logger.error("Missing temperature or humidity variables in GRIB2.")
        raise ValueError("GRIB2 missing expected variables (t, r at isobaricInhPa)")

    t_sel = t_ds.sel(isobaricInhPa=PRESSURE_HPA, method="nearest")["t"]
    r_sel = r_ds.sel(isobaricInhPa=PRESSURE_HPA, method="nearest")["r"]

    lats = t_sel.latitude.values
    lons = t_sel.longitude.values
    T_arr = t_sel.values
    R_arr = r_sel.values

    cells: list[dict] = []
    for i, lat in enumerate(lats):
        if not (24.0 <= float(lat) <= 55.0):
            continue
        for j, lon_raw in enumerate(lons):
            lon = float(lon_raw) if lon_raw <= 180 else float(lon_raw) - 360.0
            if not (-130.0 <= lon <= -60.0):
                continue
            T_K = float(T_arr[i, j])
            rhi = rhl_to_rhi(float(R_arr[i, j]), T_K)
            sac = schmidt_appleman(T_K, PRESSURE_HPA, rhi)
            risk = float(np.clip((rhi - 0.9) * 2.5, 0.0, 1.0)) if sac else 0.0
            if risk > 0.05:
                cells.append(
                    {
                        "lat": float(lat),
                        "lon": lon,
                        "T_K": T_K,
                        "rhi": rhi,
                        "risk_score": risk,
                    }
                )
    logger.info("Extracted %d ISSR-positive cells.", len(cells))
    return cells


# ── Cluster cells into GeoJSON polygons ───────────────────────────────────
def cells_to_features(cells: list[dict], valid_time: str) -> list[dict]:
    step = 0.25  # GFS 0.25° grid
    half = step / 2.0
    features = []

    buckets: dict[str, list[dict]] = {"high": [], "medium": [], "low": []}
    for c in cells:
        if c["risk_score"] >= 0.7:
            buckets["high"].append(c)
        elif c["risk_score"] >= 0.4:
            buckets["medium"].append(c)
        else:
            buckets["low"].append(c)

    try:
        from shapely.geometry import mapping, Polygon as SP  # type: ignore
        from shapely.ops import unary_union  # type: ignore

        use_shapely = True
    except ImportError:
        use_shapely = False

    altitude_ft = int(44307.69 * (1.0 - (PRESSURE_HPA / 1013.25) ** 0.190284))

    for risk_level, bucket in buckets.items():
        if not bucket:
            continue
        avg_T = sum(c["T_K"] for c in bucket) / len(bucket)
        avg_rhi = sum(c["rhi"] for c in bucket) / len(bucket)
        avg_score = sum(c["risk_score"] for c in bucket) / len(bucket)

        if use_shapely:
            polys = [
                SP(
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
            geoms = list(merged.geoms) if merged.geom_type == "MultiPolygon" else [merged]
            for geom in geoms:
                if geom.area < 0.5:
                    continue
                area_km2 = int(geom.area * 111.32**2)
                features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "risk_level": risk_level,
                            "risk_score": round(avg_score, 3),
                            "altitude_ft": altitude_ft,
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
            lats = [c["lat"] for c in bucket]
            lons = [c["lon"] for c in bucket]
            lat_min, lat_max = min(lats) - half, max(lats) + half
            lon_min, lon_max = min(lons) - half, max(lons) + half
            area_km2 = int((lat_max - lat_min) * (lon_max - lon_min) * 111.32**2)
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "risk_level": risk_level,
                        "risk_score": round(avg_score, 3),
                        "altitude_ft": altitude_ft,
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


# ── Lambda entry point ────────────────────────────────────────────────────
def handler(event: dict, context: object) -> dict:
    logger.info("Predict Lambda invoked. Event: %s", json.dumps(event))
    s3 = boto3.client("s3")
    cf = boto3.client("cloudfront") if CF_DIST_ID else None

    # Parse S3 trigger
    record = event["Records"][0]["s3"]
    bucket = record["bucket"]["name"]
    key = record["object"]["key"]  # scenes/<scene_id>/manifest.json
    logger.info("Triggered by s3://%s/%s", bucket, key)

    # Read manifest
    manifest_obj = s3.get_object(Bucket=bucket, Key=key)
    manifest = json.loads(manifest_obj["Body"].read())
    scene_id = manifest["scene_id"]
    grib2_key = manifest["grib2_key"]
    valid_time = manifest.get("ingested_at", datetime.now(timezone.utc).isoformat())
    logger.info("Processing scene: %s", scene_id)

    # Download GRIB2 to /tmp
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
        tmp_path = tmp.name
    logger.info("Downloading s3://%s/%s → %s", INPUT_BUCKET, grib2_key, tmp_path)
    s3.download_file(INPUT_BUCKET, grib2_key, tmp_path)

    try:
        cells = extract_issr_cells(tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    features = cells_to_features(cells, valid_time)
    logger.info("Produced %d GeoJSON features.", len(features))

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "generated": datetime.now(timezone.utc).isoformat(),
            "forecast_valid": valid_time,
            "forecast_source": "GFS 0.25°",
            "pressure_hpa": PRESSURE_HPA,
            "model": "pycontrails CoCiP + Schmidt–Appleman",
            "scene_id": scene_id,
        },
        "features": features,
    }
    body = json.dumps(geojson)

    # Write scene-specific output
    scene_key = f"scenes/{scene_id}/contrails.geojson"
    s3.put_object(
        Bucket=OUTPUT_BUCKET,
        Key=scene_key,
        Body=body,
        ContentType="application/geo+json",
        CacheControl="max-age=21600",  # 6 h
    )
    logger.info("Wrote s3://%s/%s", OUTPUT_BUCKET, scene_key)

    # Overwrite latest.geojson
    s3.put_object(
        Bucket=OUTPUT_BUCKET,
        Key="latest.geojson",
        Body=body,
        ContentType="application/geo+json",
        CacheControl="max-age=300",  # 5 min so frontend refreshes quickly
    )
    logger.info("Updated latest.geojson")

    # Invalidate CloudFront cache for /latest.geojson
    if cf and CF_DIST_ID:
        cf.create_invalidation(
            DistributionId=CF_DIST_ID,
            InvalidationBatch={
                "Paths": {"Quantity": 1, "Items": ["/latest.geojson"]},
                "CallerReference": scene_id,
            },
        )
        logger.info("CloudFront invalidation requested for /latest.geojson")

    return {
        "statusCode": 200,
        "scene_id": scene_id,
        "feature_count": len(features),
        "output_key": scene_key,
    }
