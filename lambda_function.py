# this is a copy of whats deployed on lambda.
import boto3
from datetime import datetime, timezone

S3_DEST_BUCKET = "contrai-input-711726113023-us-east-1-an"

def lambda_handler(event, context):
    s3 = boto3.client("s3")
    
    # Figure out the latest GFS run
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y%m%d")
    # GFS runs at 00, 06, 12, 18 UTC. Use the most recent that's likely complete.
    hour = (now.hour // 6) * 6 - 6  # subtract 6 to ensure it's done
    if hour < 0:
        hour += 24
    hour_str = f"{hour:02d}"
    
    # Source: NOAA's public bucket
    src_key = f"gfs.{date_str}/{hour_str}/atmos/gfs.t{hour_str}z.pgrb2.0p25.f000"
    
    # Destination: your bucket
    dst_key = f"runs/{date_str}T{hour_str}.grib2"
    
    print(f"Copying {src_key} to {dst_key}")
    
    s3.copy_object(
        CopySource={"Bucket": "noaa-gfs-bdp-pds", "Key": src_key},
        Bucket=S3_DEST_BUCKET,
        Key=dst_key,
    )
    
    return {"statusCode": 200, "body": f"Copied {dst_key}"}



# import json

# def lambda_handler(event, context):
#     # TODO implement
#     return {
#         'statusCode': 200,
#         'body': json.dumps('Hello from Lambda!')
#     }


