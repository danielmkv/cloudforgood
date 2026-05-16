"""
Lambda: ingest
==============
Triggered by EventBridge every 6 hours.

Copies the latest GFS 0.25° analysis (f000) from the NOAA public bucket
into our staging bucket so the predict Lambda can process it.

Real bucket (from deployed lambda_function.py):
    contrai-input-711726113023-us-east-1-an

Key format written:
    runs/{YYYYMMDD}T{HH}.grib2   (e.g. runs/20260516T12.grib2)

Environment variables:
    S3_DEST_BUCKET — target bucket  (default: contrai-input-711726113023-us-east-1-an)
    GFS_BUCKET     — NOAA source    (default: noaa-gfs-bdp-pds)
"""

import json
import logging
import os
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

S3_DEST_BUCKET = os.environ.get(
    "S3_DEST_BUCKET", "contrai-input-711726113023-us-east-1-an"
)
GFS_BUCKET = os.environ.get("GFS_BUCKET", "noaa-gfs-bdp-pds")


def latest_gfs_run() -> tuple[str, str]:
    """
    Return (date_str YYYYMMDD, hour_str HH) of the most recent GFS run
    that is likely complete on S3.
    GFS runs at 00 / 06 / 12 / 18 UTC; each takes ~3-4 h to appear.
    Subtract 6 h to stay safely behind the processing lag.
    """
    now = datetime.now(timezone.utc)
    hour = (now.hour // 6) * 6 - 6
    if hour < 0:
        hour += 24
    date_str = now.strftime("%Y%m%d")
    return date_str, f"{hour:02d}"


def lambda_handler(event: dict, context: object) -> dict:
    """Lambda entry point — matches the signature of the deployed function."""
    logger.info("Ingest Lambda invoked.")
    s3 = boto3.client("s3")

    date_str, hour_str = latest_gfs_run()

    # Source key on NOAA's public bucket
    src_key = f"gfs.{date_str}/{hour_str}/atmos/gfs.t{hour_str}z.pgrb2.0p25.f000"

    # Destination key — same format as the deployed lambda_function.py
    dst_key = f"runs/{date_str}T{hour_str}.grib2"

    logger.info("Copying s3://%s/%s → s3://%s/%s", GFS_BUCKET, src_key, S3_DEST_BUCKET, dst_key)

    s3.copy_object(
        CopySource={"Bucket": GFS_BUCKET, "Key": src_key},
        Bucket=S3_DEST_BUCKET,
        Key=dst_key,
    )

    logger.info("Done. Wrote %s", dst_key)
    return {"statusCode": 200, "body": f"Copied {dst_key}"}


# Keep backward-compat alias so any CDK/SAM referencing handler.handler still works
handler = lambda_handler
