# this is a copy of whats deployed on lambda.
import boto3
from datetime import datetime, timedelta, timezone

S3_DEST_BUCKET = "contrai-input-711726113023-us-east-1-an"

def lambda_handler(event, context):
    s3 = boto3.client("s3")

    # GFS runs at 00, 06, 12, 18 UTC; back off 6h so f000 has finished publishing.
    cycle = datetime.now(timezone.utc) - timedelta(hours=6)
    cycle = cycle.replace(hour=(cycle.hour // 6) * 6, minute=0, second=0, microsecond=0)
    date_str = cycle.strftime("%Y%m%d")
    hour_str = cycle.strftime("%H")
    
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


