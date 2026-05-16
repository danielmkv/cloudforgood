"""
Build the ash RGB false-color composite from GOES C11, C14, C15 bands.
This is the input format the Kaggle contrail model expects.

Usage:
    python ash_rgb.py C11.nc C14.nc C15.nc

Output:
    - ash_rgb.png (the false-color image you can look at)
    - ash_rgb.npy (numpy array of shape (H, W, 3), values 0-1, model input)
"""

import sys
import xarray as xr
import numpy as np
import matplotlib.pyplot as plt


def rad_to_bt(path):
    """Open a GOES L1b file and convert radiance to brightness temperature (K)."""
    ds = xr.open_dataset(path)
    rad = ds["Rad"].values.astype(np.float32)
    fk1 = float(ds["planck_fk1"].values)
    fk2 = float(ds["planck_fk2"].values)
    bc1 = float(ds["planck_bc1"].values)
    bc2 = float(ds["planck_bc2"].values)
    bt = (fk2 / np.log((fk1 / rad) + 1) - bc1) / bc2
    band = int(ds["band_id"].values[0])
    ds.close()
    return bt, band


def normalize(x, lo, hi):
    """Clip and scale to [0, 1] for the given range."""
    return np.clip((x - lo) / (hi - lo), 0, 1)


def main(c11_path, c14_path, c15_path):
    # Load all three bands as brightness temperatures
    bt11, b11 = rad_to_bt(c11_path)
    bt14, b14 = rad_to_bt(c14_path)
    bt15, b15 = rad_to_bt(c15_path)

    # Sanity check: confirm the right bands got passed in the right order
    assert b11 == 11, f"First file should be C11, got C{b11}"
    assert b14 == 14, f"Second file should be C14, got C{b14}"
    assert b15 == 15, f"Third file should be C15, got C{b15}"

    print(f"Image shape: {bt14.shape}")
    print(f"BT11 range: {np.nanmin(bt11):.1f} to {np.nanmax(bt11):.1f} K")
    print(f"BT14 range: {np.nanmin(bt14):.1f} to {np.nanmax(bt14):.1f} K")
    print(f"BT15 range: {np.nanmin(bt15):.1f} to {np.nanmax(bt15):.1f} K")

    # Ash RGB construction. Ranges match what the Kaggle annotators saw.
    R = normalize(bt15 - bt14, -4, 2)
    G = normalize(bt14 - bt11, -4, 5)
    B = normalize(bt14, 243, 303)

    ash = np.stack([R, G, B], axis=-1).astype(np.float32)

    # Save the numpy array for later (model input)
    np.save("ash_rgb.npy", ash)
    print(f"Saved ash_rgb.npy, shape {ash.shape}")

    # Save the viewable PNG
    fig, ax = plt.subplots(figsize=(14, 8), dpi=100)
    ax.imshow(ash)
    ax.set_title("Ash RGB false color")
    ax.axis("off")
    plt.tight_layout()
    plt.savefig("ash_rgb.png", bbox_inches="tight")
    print("Saved ash_rgb.png")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: python ash_rgb.py <C11.nc> <C14.nc> <C15.nc>")
        sys.exit(1)
    main(sys.argv[1], sys.argv[2], sys.argv[3])