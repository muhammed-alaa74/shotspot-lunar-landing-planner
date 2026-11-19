import glob, os
import numpy as np, rasterio

root = "data/raw/pgda78"
for site in sorted(os.listdir(root)):
    folder = os.path.join(root, site)
    if not os.path.isdir(folder):
        continue  # skip stray files such as .DS_Store on macOS
    files = sorted(glob.glob(os.path.join(folder, "*.tif")))
    if not files:
        print(f"{site}: no .tif files found\n")
        continue
    print(f"=== {site} ===")
    ref = None
    crs = None
    for p in files:
        with rasterio.open(p) as src:
            grid = (src.width, src.height, tuple(src.transform)[:6])
            if ref is None:
                ref = grid
            a = src.read(1, out_shape=(max(1, src.height // 20), max(1, src.width // 20))).astype("float64")
            nd = src.nodata
            if nd is not None:
                a[a == nd] = np.nan
            crs = src.crs
            print(f"{os.path.basename(p)} | {src.width}x{src.height} | res={src.res} | {src.dtypes[0]} | nodata={nd} | min={np.nanmin(a):.2f} max={np.nanmax(a):.2f} | same grid as first file: {grid == ref}")
    print("crs:", str(crs)[:90])
    print()
