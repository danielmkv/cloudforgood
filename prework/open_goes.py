"""
Open a GOES-16/19 ABI L1b CONUS netCDF file and print what's inside.

Usage:
    python open_goes.py OR_ABI-L1b-RadC-M6C01_G16_s20250020206174_e20250020208547_c20250020208590.nc

Install once:
    pip install xarray netCDF4 numpy
"""

import sys
import xarray as xr
import numpy as np


def main(path):
    ds = xr.open_dataset(path)

    print("=" * 60)
    print(f"File: {path}")
    print("=" * 60)

    # Band number and central wavelength
    band = int(ds["band_id"].values[0])
    wavelength = float(ds["band_wavelength"].values[0])
    print(f"Band: C{band:02d}  ({wavelength:.2f} um)")

    # Coverage and resolution
    rad = ds["Rad"]
    print(f"Image shape: {rad.shape}  (rows x cols)")
    print(f"Dtype: {rad.dtype}")

    # Time
    t_start = ds["t"].values
    print(f"Scan midpoint time: {t_start}")

    # Spatial extent in scan-angle radians (x = E-W, y = N-S)
    print(f"x range (rad): {float(ds['x'].min()):.5f} to {float(ds['x'].max()):.5f}")
    print(f"y range (rad): {float(ds['y'].min()):.5f} to {float(ds['y'].max()):.5f}")

    # Projection info (you need this later for georeferencing)
    proj = ds["goes_imager_projection"]
    print("\nProjection:")
    print(f"  satellite height (m): {proj.attrs['perspective_point_height']}")
    print(f"  sub-satellite lon:    {proj.attrs['longitude_of_projection_origin']}")
    print(f"  sweep axis:           {proj.attrs['sweep_angle_axis']}")
    print(f"  semi-major axis (m):  {proj.attrs['semi_major_axis']}")
    print(f"  semi-minor axis (m):  {proj.attrs['semi_minor_axis']}")

    # Quick stats on the radiance values
    rad_vals = rad.values
    valid = rad_vals[~np.isnan(rad_vals)]
    print(f"\nRadiance stats (valid pixels only):")
    print(f"  count: {valid.size:,}")
    print(f"  min:   {valid.min():.3f}")
    print(f"  max:   {valid.max():.3f}")
    print(f"  mean:  {valid.mean():.3f}")
    print(f"  units: {rad.attrs.get('units', 'unknown')}")

    # For IR bands (7-16), show how to convert to brightness temp
    if band >= 7:
        fk1 = float(ds["planck_fk1"].values)
        fk2 = float(ds["planck_fk2"].values)
        bc1 = float(ds["planck_bc1"].values)
        bc2 = float(ds["planck_bc2"].values)
        bt = (fk2 / np.log((fk1 / rad_vals) + 1) - bc1) / bc2
        bt_valid = bt[~np.isnan(bt)]
        print(f"\nBrightness temperature (Kelvin):")
        print(f"  min:  {bt_valid.min():.2f}")
        print(f"  max:  {bt_valid.max():.2f}")
        print(f"  mean: {bt_valid.mean():.2f}")
    else:
        print("\n(This is a visible/near-IR band; no brightness temp conversion.)")

    # List every variable for reference
    print("\nAll variables in this file:")
    for name in ds.data_vars:
        print(f"  {name}")

    ds.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python open_goes.py <path-to-.nc-file>")
        sys.exit(1)
    main(sys.argv[1])