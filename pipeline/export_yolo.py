"""Turn exported crater labels into a YOLO dataset (one class: crater).

Put every exported labels file from the labeler in data/labels/ (one per person is fine;
they are merged by label id). Only cells marked "done" are used, because a cell with
unlabeled craters would teach the model that craters are background.

Each done cell (500 x 500 m = 500 x 500 px at 1 m/px) becomes one image per lighting
(mosaics A-E), so the model learns craters under different Sun directions. All lightings of
a cell go to the same split, so validation never sees a training cell.

Splits: test = the Site20 landing area (never trained on); train/val = training areas, 85/15 by cell.

Outputs: data/yolo/{images,labels}/{train,val,test}/..., data/yolo/data.yaml,
         data/yolo/ground_truth.csv (craters in map meters, for evaluation)

Usage: python pipeline/export_yolo.py [--include-unsure]
"""
import csv
import hashlib
import json
import shutil
import sys

import numpy as np
from PIL import Image

from terrain import ROOT

CELL = 500
MIN_D = 10.0
MIN_VISIBLE = 0.4      # keep a box cut by the cell edge only if >= 40 % of it is inside
MAX_NODATA = 0.2


def load_labels():
    labels, done = {}, {}
    files = sorted((ROOT / "data/labels").glob("*.json"))
    if not files:
        sys.exit("No label files in data/labels/. Export from the labeler and copy them there.")
    for f in files:
        d = json.loads(f.read_text())
        for l in d.get("labels", []):
            labels[l["id"]] = l
        for a, cells in d.get("doneCells", {}).items():
            done.setdefault(a, set()).update(cells)
        print(f"read {f.name}: {len(d.get('labels', []))} labels")
    return list(labels.values()), done


def split_of(role, area, cell):
    if role == "test":
        return "test"
    h = int(hashlib.md5(f"{area}:{cell}".encode()).hexdigest(), 16) % 100
    return "val" if h < 15 else "train"


def main(include_unsure=False):
    areas = json.loads((ROOT / "web/labeler/areas.json").read_text())["areas"]
    labels, done = load_labels()
    out = ROOT / "data/yolo"
    if out.exists():
        shutil.rmtree(out)
    counts = {s: {"images": 0, "boxes": 0} for s in ("train", "val", "test")}
    gt_rows = []
    for area, info in areas.items():
        cells = sorted(done.get(area, []))
        if not cells:
            continue
        L = [l for l in labels if l["area"] == area and 2 * l["r"] >= MIN_D and (include_unsure or not l.get("unsure"))]
        for cell in cells:
            c, r = map(int, cell.split(","))
            x0, y0 = c * CELL, r * CELL                      # cell origin in image pixels
            split = split_of(info["role"], area, cell)
            boxes = []
            for l in L:
                px, py, rad = l["x"] - info["left"], info["top"] - l["y"], l["r"]
                bx0, by0, bx1, by1 = px - rad, py - rad, px + rad, py + rad
                ix0, iy0, ix1, iy1 = max(bx0, x0), max(by0, y0), min(bx1, x0 + CELL), min(by1, y0 + CELL)
                if ix1 <= ix0 or iy1 <= iy0:
                    continue
                if (ix1 - ix0) * (iy1 - iy0) < MIN_VISIBLE * (bx1 - bx0) * (by1 - by0):
                    continue
                boxes.append(((ix0 + ix1) / 2 - x0, (iy0 + iy1) / 2 - y0, ix1 - ix0, iy1 - iy0))
                if x0 <= px < x0 + CELL and y0 <= py < y0 + CELL:
                    gt_rows.append([split, area, cell, l["id"], l["x"], l["y"], 2 * l["r"], int(bool(l.get("unsure")))])
            for v in info["mosaics"]:
                img = np.asarray(Image.open(ROOT / "data/nac/site20" / area / f"{v}.png"))[y0:y0 + CELL, x0:x0 + CELL]
                if img.shape != (CELL, CELL) or (img == 0).mean() > MAX_NODATA:
                    continue
                name = f"{area}_{c}_{r}_{v}"
                (out / "images" / split).mkdir(parents=True, exist_ok=True)
                (out / "labels" / split).mkdir(parents=True, exist_ok=True)
                Image.fromarray(img).save(out / "images" / split / f"{name}.png")
                with open(out / "labels" / split / f"{name}.txt", "w") as f:
                    for bx, by, bw, bh in boxes:
                        f.write(f"0 {bx / CELL:.6f} {by / CELL:.6f} {bw / CELL:.6f} {bh / CELL:.6f}\n")
                counts[split]["images"] += 1
                counts[split]["boxes"] += len(boxes)
    (out / "data.yaml").write_text(
        f"path: {out}\ntrain: images/train\nval: images/val\ntest: images/test\nnames:\n  0: crater\n")
    with open(out / "ground_truth.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["split", "area", "cell", "id", "x_m", "y_m", "diameter_m", "unsure"])
        w.writerows(gt_rows)
    for s, v in counts.items():
        print(f"{s:5s}: {v['images']:5d} images, {v['boxes']:6d} boxes")
    print(f"wrote {out}/data.yaml")


if __name__ == "__main__":
    main(include_unsure="--include-unsure" in sys.argv)
