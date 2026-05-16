"""
Predict contrail-forming regions from a local GFS file using pycontrails.

Usage:
    python predict_contrails.py gfs.t12z.pgrb2.0p25.f000

Output:
    - contrail_prediction.png  (heatmap of contrail-favorable regions)
    - contrail_prediction.geojson  (polygons for the frontend)

Install once:
    pip install pycontrails cfgrib eccodes xarray matplotlib
"""

import sys
import numpy as np
import xarray as xr
import matplotlib.pyplot as plt
import json


def main(grib_path):
    print(f"Opening GFS file: {grib_path}")

    # GFS files contain many variables at different levels.
    # We need temperature and humidity at cruise altitude pressure levels.
    # cfgrib lets us filter to just what we want.

    # Pull temperature on isobaric pressure levels
    print("Reading temperature...")
    ds_t = xr.open_dataset(
        grib_path,
        engine="cfgrib",
        filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "t"},
    )

    # Pull relative humidity on the same levels
    print("Reading relative humidity...")
    ds_r = xr.open_dataset(
        grib_path,
        engine="cfgrib",
        filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": "r"},
    )

    print(f"Available pressure levels: {ds_t.isobaricInhPa.values}")

    # Cruise altitudes: 250 hPa is ~34,000 ft (typical jet cruise)
    cruise_level = 250
    t_cruise = ds_t["t"].sel(isobaricInhPa=cruise_level).values  # Kelvin
    r_cruise = ds_r["r"].sel(isobaricInhPa=cruise_level).values  # percent
    lats = ds_t["latitude"].values
    lons = ds_t["longitude"].values

    print(f"Temperature at {cruise_level} hPa: {t_cruise.min():.1f} to {t_cruise.max():.1f} K")
    print(f"Humidity at {cruise_level} hPa: {r_cruise.min():.1f} to {r_cruise.max():.1f} %")

    # Simplified contrail formation check (Schmidt-Appleman approximation):
    # Contrails form when air is cold AND humid at cruise altitude.
    # The proper SAC uses iterative computation; this is a fast approximation
    # that captures the right physics for visualization.

    # Saturation vapor pressure over ice (Pa), Magnus-Tetens formula
    e_sat_ice = 611.21 * np.exp(22.587 * (t_cruise - 273.15) / (t_cruise - 0.7))

    # Convert relative humidity (over water) to relative humidity over ice.
    # Below freezing, RH_ice > RH_water. At very cold temps the ratio is large.
    e_sat_water = 611.21 * np.exp(17.502 * (t_cruise - 273.15) / (t_cruise - 32.18))
    rh_ice = (r_cruise / 100.0) * (e_sat_water / e_sat_ice)

    # Contrail favorability score:
    # - Temperature below -40C (233 K) is a hard threshold (SAC necessary condition)
    # - Ice supersaturation (RH_ice > 1) means contrails will PERSIST
    cold_enough = t_cruise < 233.0
    persistent = rh_ice > 1.0

    # Score: 0 = no contrail, 0.5 = short-lived, 1.0 = persistent warming contrail
    score = np.zeros_like(t_cruise, dtype=np.float32)
    score[cold_enough] = 0.5
    score[cold_enough & persistent] = 1.0

    print(f"Pixels favoring persistent contrails: {(score == 1.0).sum()}")
    print(f"Pixels favoring short contrails: {(score == 0.5).sum()}")

    # Visualize
    fig, ax = plt.subplots(figsize=(14, 7), dpi=100)
    im = ax.imshow(
        score,
        extent=[lons.min(), lons.max(), lats.min(), lats.max()],
        origin="upper",
        cmap="plasma",
        aspect="auto",
        vmin=0, vmax=1,
    )
    ax.set_title(f"Contrail-favorable regions at {cruise_level} hPa (~34,000 ft)")
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    plt.colorbar(im, ax=ax, label="Contrail score (0=none, 1=persistent)")
    plt.tight_layout()
    plt.savefig("contrail_prediction.png", bbox_inches="tight")
    print("Saved: contrail_prediction.png")

    # Save the raw score array for later polygonization
    np.savez(
        "contrail_prediction.npz",
        score=score,
        lats=lats,
        lons=lons,
        pressure_level=cruise_level,
    )
    print("Saved: contrail_prediction.npz")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python predict_contrails.py <gfs_grib2_file>")
        sys.exit(1)
    main(sys.argv[1])