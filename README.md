# Contraiλ — Contrail Formation Risk Forecast

> **AWS Hackathon 2026 — Serverless Track**
> Cloud For Good · Team: Leon Truong · Luke Prasarttongosoth · Daniel Mitroshkov · Raio Chea

Contrails account for roughly **30–50% of aviation's total climate impact** — more than CO₂ alone.
This burden is addressable: a flight that knows where persistent contrails will form can shift altitude
by a few thousand feet and avoid them. ContrAI makes that information publicly accessible.

Contraiλ fetches real NOAA GFS weather data every 6 hours, runs the Schmidt–Appleman criterion to
predict ice-supersaturated regions at cruise altitude, and renders the results as an interactive
risk map. Pilots, dispatchers, and climate-conscious travellers can visualise the warming cost of
any route in seconds.

---

## AWS Services

| Service | Role |
|---|---|
| **EventBridge** | Scheduled rule — triggers ingest every 6 hours |
| **Lambda (zip)** | `contrai-ingest` — Python 3.12, copies GFS GRIB2 from NOAA |
| **Lambda (container)** | `contrai-predict` — Python 3.12 + cfgrib + rasterio + shapely |
| **ECR** | Container registry for the predict image |
| **S3** | `contrai-input` (GFS staging) · `contrai-contrails` (GeoJSON + frontend) |
| **CloudFront** | CDN for frontend static assets + `/latest.geojson` with 5-min TTL |

## Architecture

```
EventBridge (every 6 h)
        │  scheduled trigger
        ▼
Lambda: ingest              ← fetches latest GFS 0.25° GRIB2 from s3://noaa-gfs-bdp-pds
        │  writes runs/{YYYYMMDD}T{HH}.grib2
        ▼
S3: contrai-input           ← s3://contrai-input-711726113023-us-east-1-an/
        │  ObjectCreated trigger (runs/*.grib2)
        ▼
Lambda: predict (container) ← Schmidt–Appleman + RHi scoring → concentric risk rings
        │  writes latest.geojson + runs/{id}/contrails.geojson
        ▼
S3: contrai-contrails       ← s3://contrai-contrails/latest.geojson
        │  CloudFront origin (max-age=300 s)
        ▼
CloudFront CDN              ← https://d<id>.cloudfront.net/latest.geojson
        │  also serves Next.js static export
        ▼
Next.js frontend            ← Leaflet map · airport picker · SLERP route · warming calculator
```

---

## Project Layout

```
cloudforgood/
├── frontend/                     # Next.js 15 (App Router, TypeScript, Tailwind CSS)
│   ├── app/
│   │   ├── page.tsx              # Root page (dynamic import of ContrailMap)
│   │   ├── layout.tsx
│   │   ├── globals.css           # Light theme + Leaflet overrides
│   │   └── components/
│   │       ├── ContrailMap.tsx   # Leaflet map, SLERP route, point-in-polygon risk calc
│   │       ├── Sidebar.tsx       # Airport search, aircraft picker, forecast metadata
│   │       ├── RiskPopup.tsx     # Click-to-inspect polygon popup
│   │       └── WarmingPanel.tsx  # Route climate impact (tCO₂e, risk-scaled colours)
│   └── public/data/
│       ├── airports.json         # ~150 North American airports
│       └── latest.geojson        # Bundled demo data (real GFS run, 16 May 2026)
│
├── lambda/
│   ├── ingest/
│   │   ├── handler.py            # EventBridge → NOAA S3 copy
│   │   └── requirements.txt
│   └── predict/
│       ├── handler.py            # S3 trigger → Schmidt–Appleman → GeoJSON
│       ├── Dockerfile            # Container image (eccodes + cfgrib + rasterio)
│       └── requirements.txt
│
├── scripts/
│   ├── generate_geojson.py       # Offline demo GeoJSON (synthetic or real GFS)
│   ├── make_rings.py             # Post-processes output.geojson into warm concentric rings
│   └── requirements.txt
│
└── prediction_local/
    ├── predict_local.py          # Local pipeline (GRIB2 → continuous score → GeoJSON)
    └── contrail_prediction.npz   # Cached GFS score grid for offline ring generation
```

---

## How Contrail Risk Is Calculated

1. **GFS 250 hPa layer** — temperature (T) and relative humidity over water (RH) at cruise altitude.
2. **RHi conversion** — RH over liquid → relative humidity over ice using the Magnus–Tetens equation.
3. **Schmidt–Appleman criterion** — contrail formation requires T < 233 K (SAC threshold).
4. **Continuous risk score**
   ```
   cold_factor = clip((233 − T) / 20,   0, 1)   # 0 at threshold, 1 at ~213 K
   rhi_factor  = clip((RHi − 0.7) / 0.6, 0, 1)  # 0 at dry, 1 at strongly supersaturated
   score       = cold_factor × rhi_factor          # only where T < 233 K
   ```
5. **Vectorisation** — rasterio converts the score raster to Shapely polygons; each polygon
   is then eroded inward at 6 depth steps to produce concentric warm rings (score 0.78→0.99),
   giving colour variation from yellow-orange fringe to deep-red core within each risk zone.
6. **GeoJSON output** — written to S3 as `latest.geojson`; CloudFront serves it with a 5-minute
   TTL so the map updates automatically after each GFS run.

### Warming Impact Formula

Based on Teoh et al. (2022) and Lee et al. (2021), expressed in CO₂-equivalent tonnes (tCO₂e):

```
Contrail impact = route_risk_km × fuel_burn_kg_per_km × 11.2 × aircraft_RF_factor / 1000
CO₂ impact      = route_km × fuel_burn_kg_per_km × 3.16 / 1000
```

The contrail share (amber → orange → red) is coloured dynamically based on whether it is
below 10%, 10–30%, 30–60%, or above 60% of total climate impact.

### Route Calculation

Great-circle routes are computed with correct spherical linear interpolation (SLERP) and sampled
at 81 points. Each point is tested against all risk polygon rings using ray-casting
point-in-polygon. The percentage of points inside any ring determines `routeRiskKm`.

---

## Running Locally (Demo Mode)

### Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:3001
```

The frontend loads `public/data/latest.geojson` (bundled real GFS data, 16 May 2026 12:00 UTC)
and `public/data/airports.json`. No AWS credentials needed.

### Regenerate ring GeoJSON from a local GFS run

```bash
# 1. Run the local pipeline to get raw polygons
cd prediction_local
python predict_local.py gfs.t12z.pgrb2.0p25.f000 output.geojson

# 2. Post-process into concentric warm rings
cd ..
python scripts/make_rings.py prediction_local/output.geojson frontend/public/data/latest.geojson
```

### Generate synthetic demo data

```bash
cd scripts
pip install -r requirements.txt
python generate_geojson.py --demo --out ../frontend/public/data/latest.geojson
```

---

## Deploying to AWS

### 1 — S3 buckets

```bash
aws s3 mb s3://contrai-input-711726113023-us-east-1-an --region us-east-1
aws s3 mb s3://contrai-contrails --region us-east-1

# Lifecycle rule: delete input GRIB2 files after 2 days to control cost
aws s3api put-bucket-lifecycle-configuration \
  --bucket contrai-input-711726113023-us-east-1-an \
  --lifecycle-configuration file://infra/lifecycle-input.json
```

### 2 — Lambda: ingest (zip)

```bash
cd lambda/ingest
pip install -r requirements.txt -t package/
cp handler.py package/
cd package && zip -r ../function.zip . && cd ..
aws lambda create-function \
  --function-name contrai-ingest \
  --runtime python3.12 \
  --role arn:aws:iam::<account>:role/contrai-lambda-role \
  --handler handler.lambda_handler \
  --zip-file fileb://function.zip \
  --timeout 300 \
  --environment "Variables={S3_DEST_BUCKET=contrai-input-711726113023-us-east-1-an}"
```

### 3 — Lambda: predict (container image)

```bash
cd lambda/predict
aws ecr create-repository --repository-name contrai-predict --region us-east-1
docker build -t contrai-predict .
docker tag contrai-predict:latest <account>.dkr.ecr.us-east-1.amazonaws.com/contrai-predict:latest
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/contrai-predict:latest

aws lambda create-function \
  --function-name contrai-predict \
  --package-type Image \
  --code ImageUri=<account>.dkr.ecr.us-east-1.amazonaws.com/contrai-predict:latest \
  --role arn:aws:iam::<account>:role/contrai-lambda-role \
  --timeout 600 \
  --memory-size 3008 \
  --environment "Variables={S3_SRC_BUCKET=contrai-input-711726113023-us-east-1-an,S3_DST_BUCKET=contrai-contrails,CLOUDFRONT_DIST_ID=<dist-id>}"
```

### 4 — EventBridge rule

```bash
aws events put-rule \
  --name contrai-ingest-schedule \
  --schedule-expression "rate(6 hours)" \
  --state ENABLED

aws events put-targets \
  --rule contrai-ingest-schedule \
  --targets "Id=1,Arn=arn:aws:lambda:us-east-1:<account>:function:contrai-ingest"

# Grant EventBridge permission to invoke the Lambda
aws lambda add-permission \
  --function-name contrai-ingest \
  --statement-id eventbridge-invoke \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com
```

### 5 — S3 trigger for predict Lambda

In the AWS console: add an S3 ObjectCreated notification on
`contrai-input-711726113023-us-east-1-an` filtered to prefix `runs/` and suffix `.grib2`,
targeting `contrai-predict`.

### 6 — Deploy frontend

```bash
cd frontend
npm run build        # Next.js static export → out/
aws s3 sync out/ s3://contrai-contrails/frontend/ --delete
```

Create a CloudFront distribution:
- **Origin 1**: `contrai-contrails.s3.amazonaws.com` for frontend assets (`/frontend/*`)
- **Origin 2**: same bucket for `/latest.geojson` with `Cache-Control: max-age=300`
- Enable CloudFront invalidation via `CLOUDFRONT_DIST_ID` env var on the predict Lambda

---

## References

- Schumann, U. (1996). On conditions for contrail formation from aircraft exhausts. *Meteorol. Z.*
- Teoh, R., et al. (2022). Mitigating the Climate Forcing of Aircraft Contrails by Changing
  Flight Altitude. *Nature Climate Change.*
- Lee, D.S., et al. (2021). The contribution of global aviation to anthropogenic climate forcing.
  *Atmospheric Environment.*
- [NOAA GFS open data on AWS](https://registry.opendata.aws/noaa-gfs-bdp-pds/)
- [pycontrails — open contrail science library](https://py.contrails.earth/)
