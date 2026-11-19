"""Crop LROC NAC controlled mosaics (1 m/px) over Mons Mouton for crater labeling.

Source: LROC NAC ROI controlled mosaics NAC_ROI_MTMOUTONLO{A..E}_P854S0353
(Henriksen et al. 2023, NASA/GSFC/Arizona State University). Same polar stereographic grid
as the LOLA DEMs. Each mosaic has a different Sun direction (sub-solar longitude range), so
together they show terrain that one lighting leaves in shadow.

Only the needed windows are read (tiled .PYR.TIF over HTTP), never the 1 GB files.

Areas:
  test   = the Site20 landing-analysis area (aim point +-1.5 km). The model is evaluated here
           and never trained on it.
  trainN = separate 3 x 3 km boxes elsewhere on the mosaic, used for training.

Outputs:
  data/nac/site20/<area>/<mosaic>.png        lossless 8-bit crops (for training)
  web/labeler/tiles/<area>/<mosaic>.jpg      the same crops for the labeling page
  web/labeler/areas.json                     area bounds + mosaic list

Usage: python pipeline/nac_crops.py
"""
import json
import os
import time

os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "6")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "5")
os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")

import numpy as np  # noqa: E402
import rasterio  # noqa: E402
from PIL import Image  # noqa: E402
from rasterio.windows import from_bounds  # noqa: E402

from terrain import ROOT  # noqa: E402

BASE = ("https://pds.lroc.im-ldi.com/data/LRO-L-LROC-5-RDR-V1.0/LROLRC_2001/EXTRAS/BROWSE/NAC_ROI/"
        "MTMOUTONLO{v}/NAC_ROI_MTMOUTONLO{v}_P854S0353.PYR.TIF")
MOSAICS = {  # letter -> sub-solar longitude range (deg), from the LROC product pages
    "A": "355-75", "B": "95-105", "C": "125-145", "D": "265-295", "E": "295-315",
}
HALF = 1500.0
AIM = json.loads((ROOT / "web/data/site20/meta.json").read_text())["site"]["aim_xy"]
AREAS = {
    "test": (AIM[0], AIM[1]),
    "train1": (80000.0, 109000.0),
    "train2": (88000.0, 118000.0),
    "train3": (69000.0, 104500.0),
}


def main():
    out_png = ROOT / "data/nac/site20"
    out_web = ROOT / "web/labeler/tiles"
    index = {"source": "LROC NAC ROI controlled mosaics, Mons Mouton (NASA/GSFC/Arizona State University; "
                       "Henriksen et al. 2023)", "res_m": 1.0, "areas": {}}
    for area, (cx, cy) in AREAS.items():
        left, top = cx - HALF, cy + HALF
        index["areas"][area] = {"left": left, "top": top, "size_m": 2 * HALF, "role": "test" if area == "test" else "train",
                                "mosaics": {}}
        for v, sub in MOSAICS.items():
            png = out_png / area / f"{v}.png"
            jpg = out_web / area / f"{v}.jpg"
            if not png.exists():
                for attempt in range(4):
                    try:
                        with rasterio.open("/vsicurl/" + BASE.format(v=v)) as d:
                            w = from_bounds(left, cy - HALF, cx + HALF, top, d.transform)
                            a = d.read(1, window=w, boundless=True, fill_value=0)
                        break
                    except Exception as e:  # noqa: BLE001  (server rate limits: wait and retry)
                        print(f"  {area}/{v}: {str(e)[:70]} - retry in {20 * (attempt + 1)} s")
                        time.sleep(20 * (attempt + 1))
                else:
                    print(f"  {area}/{v}: skipped")
                    continue
                png.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(a).save(png)
                time.sleep(2)
            a = np.asarray(Image.open(png))
            if a.max() == 0:
                print(f"  {area}/{v}: no data here, skipped")
                continue
            empty = float((a == 0).mean())
            lit = float((a > 0.05 * np.percentile(a[a > 0], 99.5)).mean())
            jpg.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(a).save(jpg, quality=92)
            index["areas"][area]["mosaics"][v] = {"sub_solar_lon": sub, "lit_fraction": round(lit, 3),
                                                  "no_data_fraction": round(empty, 3), "file": f"tiles/{area}/{v}.jpg"}
            print(f"{area:7s} {v}  sub-solar {sub:>7s}  lit {lit * 100:4.0f}%  no-data {empty * 100:4.0f}%  {a.shape}")
    (ROOT / "web/labeler/areas.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
