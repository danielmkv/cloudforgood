"""
Render a GOES ABI L1b netCDF file as a PNG image you can actually look at.

Usage:
    python view_goes.py OR_ABI-L1b-RadC-M6C01_G16_s...nc

Output: a PNG file next to the input with the same name + .png

Install once:
    pip install xarray netCDF4 numpy matplotlib
"""

import sys
import os
import xarray as xr
import numpy as np
import matplotlib.pyplot as plt


def main(path):
    ds = xr.open_dataset(path)
    band = int(ds["band_id"].values[0])
    wavelength = float(ds["band_wavelength"].values[0])
    rad = ds["Rad"].values

    # For IR bands (7-16), convert to brightness temperature in Kelvin.
    # For visible/near-IR bands (1-6), use radiance directly.
    if band >= 7:
        fk1 = float(ds["planck_fk1"].values)
        fk2 = float(ds["planck_fk2"].values)
        bc1 = float(ds["planck_bc1"].values)
        bc2 = float(ds["planck_bc2"].values)
        img = (fk2 / np.log((fk1 / rad) + 1) - bc1) / bc2
        # IR bands look natural when inverted (cold clouds = white, warm surface = dark)
        cmap = "gray_r"
        label = "Brightness Temperature (K)"
    else:
        img = rad
        cmap = "gray"
        label = "Radiance (W m^-2 sr^-1 um^-1)"

    # Stretch contrast: clip to 2nd-98th percentile so a few extreme pixels
    # don't make everything else look flat.
    valid = img[~np.isnan(img)]
    vmin, vmax = np.percentile(valid, [2, 98])

    fig, ax = plt.subplots(figsize=(10, 6), dpi=120)
    im = ax.imshow(img, cmap=cmap, vmin=vmin, vmax=vmax)
    ax.set_title(f"GOES Band C{band:02d}  ({wavelength:.2f} um)")
    ax.set_xticks([])
    ax.set_yticks([])
    plt.colorbar(im, ax=ax, label=label, shrink=0.8)
    plt.tight_layout()

    out = os.path.splitext(path)[0] + ".png"
    plt.savefig(out, bbox_inches="tight")
    print(f"Wrote: {out}")

    ds.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python view_goes.py <path-to-.nc-file>")
        sys.exit(1)
    main(sys.argv[1])