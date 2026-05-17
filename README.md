# ContrAI — Contrail Formation Risk Forecast

> Cloud For Good · AWS Hackathon 2026  
> Team: Leon Truong · Luke Prasarttongosoth · Daniel Mitroshkov · Raio Chea

Contrails account for roughly **30% of aviation's total climate impact** — more than CO₂ alone.
This environmental burden can be easily reduced so long as a flight is aware of the contrail-risk
zones and avoids them. ContrAI helps make this information publically accessible and interpretable.
ContrAI predicts where persistent contrails will form using real GFS weather data and the
[pycontrails](https://py.contrails.earth/) scientific library, then displays risk zones on an
interactive map so pilots, dispatchers, and curious users can see the climate cost of any flight.

---

## Architecture

```
EventBridge (every 6 h)
        │
        ▼
Lambda: ingest              ← fetches GFS 0.25° GRIB2 from s3://noaa-gfs-bdp-pds
        │ writes gfs.grib2 + manifest.json
        ▼
S3: contrai-input           ← s3://contrai-input/scenes/<scene_id>/
        │ ObjectCreated trigger
        ▼
Lambda: predict (container) ← pycontrails + cfgrib + Schmidt–Appleman criterion
        │ writes contrails.geojson + latest.geojson
        ▼
S3: contrai-contrails       ← s3://contrai-contrails/latest.geojson
        │ CloudFront origin
        ▼
CloudFront CDN              ← https://d<id>.cloudfront.net/latest.geojson
        │ also serves Next.js static export
        ▼
Next.js frontend            ← Leaflet map, airport picker, warming calculator
```

### AWS Services Used
| Service | Role |
|---|---|
| **S3** | `contrai-input` (GFS staging) · `contrai-contrails` (GeoJSON output + frontend hosting) |
| **Lambda** | `ingest` (Python 3.12, zip) · `predict` (Python 3.12, container image) |
| **EventBridge** | Scheduled rule: triggers ingest every 6 hours |
| **CloudFront** | CDN for frontend static assets + `/latest.geojson` with short TTL |
| **ECR** | Container registry for the predict Lambda image |

---

## Project Layout

```
cloudforgood/
├── frontend/               # Next.js 15 app (App Router, TypeScript, Tailwind)
│   ├── app/
│   │   ├── page.tsx        # Root page (dynamic import of ContrailMap)
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   └── components/
│   │       ├── ContrailMap.tsx   # Main map component (Leaflet)
│   │       ├── Sidebar.tsx       # Airport search + aircraft picker
│   │       ├── RiskPopup.tsx     # Click-popup for contrail polygons
│   │       └── WarmingPanel.tsx  # Route warming impact calculator
│   └── public/data/
│       ├── airports.json         # ~150 North American airports
│       └── latest.geojson        # Bundled demo contrail risk data
│
├── lambda/
│   ├── ingest/
│   │   ├── handler.py      # EventBridge → fetch GFS from NOAA S3
│   │   └── requirements.txt
│   └── predict/
│       ├── handler.py      # S3 trigger → ISSR analysis → GeoJSON
│       ├── Dockerfile      # Container image (pycontrails + cfgrib)
│       └── requirements.txt
│
├── scripts/
│   ├── generate_geojson.py # Offline demo GeoJSON generator
│   └── requirements.txt
│
└── prework/                # GOES ABI data exploration (team reference)
```

---

## Running Locally (Demo Mode)

### Frontend

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

The frontend loads `public/data/latest.geojson` (bundled demo data) and
`public/data/airports.json` at startup. No AWS credentials needed.

### Generate fresh demo GeoJSON

```bash
cd scripts
pip install -r requirements.txt
python generate_geojson.py --demo --out ../frontend/public/data/latest.geojson
```

### Generate from real GFS data

```bash
# Download a GFS GRIB2 file first:
aws s3 cp s3://noaa-gfs-bdp-pds/gfs.20260516/18/atmos/gfs.t18z.pgrb2.0p25.f000 gfs.grib2 \
  --no-sign-request

python generate_geojson.py --gfs gfs.grib2 --out ../frontend/public/data/latest.geojson
```

---

## Deploying to AWS

### 1 — S3 buckets

```bash
aws s3 mb s3://contrai-input
aws s3 mb s3://contrai-contrails --region us-east-1
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
  --handler handler.handler \
  --zip-file fileb://function.zip \
  --timeout 300 \
  --environment "Variables={INPUT_BUCKET=contrai-input}"
```

### 3 — Lambda: predict (container)

```bash
cd lambda/predict
aws ecr create-repository --repository-name contrai-predict
docker build -t contrai-predict .
docker tag contrai-predict:latest <account>.dkr.ecr.us-east-1.amazonaws.com/contrai-predict:latest
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/contrai-predict:latest

aws lambda create-function \
  --function-name contrai-predict \
  --package-type Image \
  --code ImageUri=<account>.dkr.ecr.us-east-1.amazonaws.com/contrai-predict:latest \
  --role arn:aws:iam::<account>:role/contrai-lambda-role \
  --timeout 600 \
  --memory-size 3008 \
  --environment "Variables={INPUT_BUCKET=contrai-input,OUTPUT_BUCKET=contrai-contrails}"
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
```

### 5 — S3 trigger for predict Lambda

In the AWS console (or CDK): add an S3 ObjectCreated notification on
`contrai-input` filtered to `scenes/*/manifest.json`, targeting the
`contrai-predict` Lambda.

### 6 — Deploy frontend

```bash
cd frontend
npm run build   # outputs to `out/` (static export)
aws s3 sync out/ s3://contrai-contrails/frontend/ --delete
```

Create a CloudFront distribution with:
- Origin 1: `contrai-contrails.s3.amazonaws.com` (for frontend assets)
- Origin 2: same bucket for `/latest.geojson` with short TTL (300 s)

---

## How Contrail Risk Is Calculated

1. **GFS 250 hPa layer** — temperature (T) and relative humidity (RH) fields.
2. **RHi conversion** — RH over liquid → relative humidity over ice using the
   Alduchov–Eskridge equation.
3. **Schmidt–Appleman criterion** — determines whether exhaust reaches
   water-saturation (necessary for contrail formation).
4. **ISSR test** — RHi > 1.0 means the ambient air is supersaturated over ice;
   contrails that form will persist and spread.
5. **pycontrails CoCiP** — Contrail Cirrus Prediction model for full EF estimate.
6. **Risk score** = `clip((RHi − 0.9) × 2.5, 0, 1)` within SAC-positive cells.
7. **Polygons** — Shapely `unary_union` clusters adjacent risk cells into smooth
   regions, bucketed into Low / Medium / High.

### Warming Impact Formula

```
contrail_RF (mW m⁻²) =
    route_distance_inside_risk_km
    × fuel_burn_kg_per_km
    × EI_soot (1×10¹⁵ particles kg⁻¹)
    × RF_per_particle (1.5×10⁻¹⁷ W m⁻²)
    × aircraft_RF_factor

CO₂_RF (mW m⁻²) =
    route_distance_km × fuel_burn_kg_per_km × 3.16 × 0.0022
```

---

## References

- Schumann, U. (1996). On conditions for contrail formation from aircraft exhausts. *Meteorol. Z.*
- Teoh, R., et al. (2022). Mitigating the Climate Forcing of Aircraft Contrails. *Nat. Climate Change.*
- [pycontrails documentation](https://py.contrails.earth/)
- [NOAA GFS data on AWS](https://registry.opendata.aws/noaa-gfs-bdp-pds/)
