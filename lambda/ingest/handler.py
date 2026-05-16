"""
Lambda: ingest
==============
Triggered by EventBridge every 6 hours.

Fetches the latest GFS 0.25° GRIB2 forecast file for the 250 hPa level
from the NOAA public S3 bucket (s3://noaa-gfs-bdp-pds) and copies it to
our input bucket (s3://contrai-input/<scene-id>/gfs.grib2).

Environment variables (set in Lambda console / CDK):
    INPUT_BUCKET   — target S3 bucket name   (e.g. "contrai-input")
    GFS_BUCKET     — source NOAA bucket name  (default: "noaa-gfs-bdp-pds")
    GFS_PREFIX     — GFS path prefix          (default: "gfs.{YYYYMMDD}/{HH}/atmos")
    PRESSURE_LEVEL — isobaric level in hPa    (default: "250")
"""

import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3
import botocore

logger = logging.getLogger()
logger.setLevel(logging.INFO)

GFS_BUCKET = os.environ.get("GFS_BUCKET", "noaa-gfs-bdp-pds")
INPUT_BUCKET = os.environ.get("INPUT_BUCKET", "contrai-input")
PRESSURE_LEVEL = os.environ.get("PRESSURE_LEVEL", "250")

# Regex to match a GFS 0.25° isobaric file containing pressure-level data.
# Matches files like: gfs.t00z.pgrb2.0p25.f000
GFS_FILE_PATTERN = re.compile(r"gfs\.t\d{2}z\.pgrb2\.0p25\.f\d{3}$")


def latest_gfs_run() -> tuple[str, str]:
    """
    Return (date_str YYYYMMDD, hour_str HH) of the most recent GFS run
    that is likely to be complete on S3 (lags by ~3–4 h from run time).
    Uses 00z / 06z / 12z / 18z cycles.
    """
    now = datetime.now(timezone.utc)
    # Step back 4 hours to account for GFS processing lag
    lag_h = 4
    effective = now.replace(minute=0, second=0, microsecond=0)
    total_h = effective.hour - lag_h
    if total_h < 0:
        total_h += 24
        effective = effective.replace(day=effective.day - 1)
    cycle_h = (total_h // 6) * 6
    date_str = effective.strftime("%Y%m%d")
    hour_str = f"{cycle_h:02d}"
    return date_str, hour_str


def find_gfs_key(s3: "boto3.client", date_str: str, hour_str: str) -> str | None:
    """
    List the GFS prefix and return the key of the analysis (f000) file.
    Falls back to the first forecast hour if f000 is absent.
    """
    prefix = f"gfs.{date_str}/{hour_str}/atmos/gfs.t{hour_str}z.pgrb2.0p25"
    logger.info("Listing s3://%s/%s*", GFS_BUCKET, prefix)
    paginator = s3.get_paginator("list_objects_v2")
    keys = []
    for page in paginator.paginate(Bucket=GFS_BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            k = obj["Key"]
            if GFS_FILE_PATTERN.search(k) and ".idx" not in k:
                keys.append(k)

    if not keys:
        return None

    # Prefer f000 (analysis), then smallest forecast hour
    keys.sort()
    for k in keys:
        if k.endswith("f000"):
            return k
    return keys[0]


def handler(event: dict, context: object) -> dict:
    """Lambda entry point."""
    logger.info("Ingest Lambda invoked. Event: %s", json.dumps(event))

    s3 = boto3.client(
        "s3",
        config=botocore.config.Config(signature_version=botocore.UNSIGNED),
    )
    s3_auth = boto3.client("s3")

    date_str, hour_str = latest_gfs_run()
    scene_id = f"{date_str}_{hour_str}z"
    logger.info("Targeting GFS run: %s", scene_id)

    gfs_key = find_gfs_key(s3, date_str, hour_str)
    if gfs_key is None:
        logger.warning("No GFS file found for %s/%s. Trying previous cycle.", date_str, hour_str)
        # Fall back to previous 6-hour cycle
        prev_h = (int(hour_str) - 6) % 24
        prev_date = date_str
        if prev_h > int(hour_str):
            # Day rolled back
            from datetime import timedelta
            d = datetime.strptime(date_str, "%Y%m%d") - timedelta(days=1)
            prev_date = d.strftime("%Y%m%d")
        hour_str = f"{prev_h:02d}"
        scene_id = f"{prev_date}_{hour_str}z"
        gfs_key = find_gfs_key(s3, prev_date, hour_str)

    if gfs_key is None:
        raise RuntimeError("Could not locate any GFS file for the last two cycles.")

    dest_key = f"scenes/{scene_id}/gfs.grib2"
    logger.info("Copying s3://%s/%s → s3://%s/%s", GFS_BUCKET, gfs_key, INPUT_BUCKET, dest_key)

    s3_auth.copy_object(
        CopySource={"Bucket": GFS_BUCKET, "Key": gfs_key},
        Bucket=INPUT_BUCKET,
        Key=dest_key,
        MetadataDirective="REPLACE",
        Metadata={
            "scene_id": scene_id,
            "source_bucket": GFS_BUCKET,
            "source_key": gfs_key,
        },
    )

    # Write a manifest so downstream Lambda knows which scene to process
    manifest = {
        "scene_id": scene_id,
        "grib2_key": dest_key,
        "pressure_hpa": PRESSURE_LEVEL,
        "ingested_at": datetime.now(timezone.utc).isoformat(),
    }
    s3_auth.put_object(
        Bucket=INPUT_BUCKET,
        Key=f"scenes/{scene_id}/manifest.json",
        Body=json.dumps(manifest),
        ContentType="application/json",
    )

    logger.info("Ingest complete. Scene: %s", scene_id)
    return {"statusCode": 200, "scene_id": scene_id, "grib2_key": dest_key}
