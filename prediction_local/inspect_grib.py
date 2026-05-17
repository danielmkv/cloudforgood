"""
Inspect the local GFS file to confirm it has the variables CoCiP needs.
"""

import sys
import xarray as xr


def inspect(grib_path):
    print(f"Inspecting: {grib_path}\n")

    # CoCiP needs these variables. Each lives on a different "typeOfLevel" in GRIB2.
    # We open the file in chunks filtered by what we want.

    print("=== Pressure-level data (temperature, humidity) ===")
    for short, name in [("t", "air_temperature"), ("r", "relative_humidity"),
                        ("u", "u-wind"), ("v", "v-wind"), ("w", "vertical_velocity")]:
        try:
            ds = xr.open_dataset(
                grib_path, engine="cfgrib",
                filter_by_keys={"typeOfLevel": "isobaricInhPa", "shortName": short},
            )
            levels = ds["isobaricInhPa"].values
            cruise_levels = [l for l in levels if 150 <= l <= 350]
            print(f"  [{short}] {name}: shape={ds[short].shape}, cruise levels available: {cruise_levels}")
            ds.close()
        except Exception as e:
            print(f"  [{short}] {name}: NOT FOUND ({type(e).__name__})")

    print("\n=== Surface/atmosphere radiation (for CoCiP rad input) ===")
    # Try several common radiation-flux variables
    for short, name in [
        ("dswrf", "downward shortwave radiation flux"),
        ("dlwrf", "downward longwave radiation flux"),
        ("uswrf", "upward shortwave radiation flux"),
        ("ulwrf", "upward longwave radiation flux"),
    ]:
        for level_type in ["surface", "nominalTop", "atmosphereSingleLayer"]:
            try:
                ds = xr.open_dataset(
                    grib_path, engine="cfgrib",
                    filter_by_keys={"typeOfLevel": level_type, "shortName": short},
                )
                print(f"  [{short}] {name} @ {level_type}: FOUND, shape={ds[short].shape}")
                ds.close()
                break
            except Exception:
                continue
        else:
            print(f"  [{short}] {name}: NOT FOUND on surface/top/atmosphere layers")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python inspect_grib.py <grib_file>")
        sys.exit(1)
    inspect(sys.argv[1])