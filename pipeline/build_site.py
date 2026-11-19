"""Precompute everything the web app needs for one site (layers 1-3 of the architecture).

Outputs to web/data/<site>/:
  meta.json       site, grid, assumptions, data sources, validation summary
  ephem.bin       float32 [n_times, 4] = sun_az, sun_el, earth_az, earth_el (deg), 10-min steps
  horizon.bin     int16  [n_spots, 360] horizon elevation in centi-degrees
  spots.bin       float32 [n_spots, 5] = x_off, y_off (m from aim), slope_deg, toterr_m, gap_m
  hillshade.png   terrain shading of the analysis area (north = toward the lunar north pole)

Also writes web/data/sites.json (the site list the page reads).

Usage: python pipeline/build_site.py [Site20 Site01 Site23]   (default: all sites below)
"""
import json
import sys
import time

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, uniform_filter

from ephemeris import az_el, utc, utc_times
from horizon import AZ_STEP_DEG, MAX_DISTANCE_M, OBSERVER_HEIGHT_M, ground_height, horizon_masks
from terrain import ROOT, far_dem, site_layers, xy_to_latlon

# Names follow NASA GSFC PGDA Product 78 (https://pgda.gsfc.nasa.gov/products/78),
# site numbering from Mazarico et al. (2011).
SITES = {
    "Site20": {"name": "Leibnitz beta plateau", "pgda_label": "Site20: Leibnitz beta plateau",
               "description": "Plateau on top of Mons Mouton, about 140 km from the pole."},
    "Site01": {"name": "Connecting ridge", "pgda_label": "Site01: Connecting ridge",
               "description": "Ridge between Shackleton and de Gerlache craters, about 16 km from the pole."},
    "Site23": {"name": "Malapert massif", "pgda_label": "Site23: Malapert massif",
               "description": "Large mountain massif (Mons Malapert), about 122 km from the pole."},
}


def pick_aim(L):
    """Demo aim point (our choice, not an official target): the highest spot with a gentle
    ~100 m average slope, at least 2.5 km inside the tile so the drift area fits."""
    s, sl = L["surf"].data, L["slp"].data
    m = np.zeros(s.shape, bool)
    edge = int(2500 / L["surf"].res)
    m[edge:-edge, edge:-edge] = True
    cand = m & (uniform_filter(sl, 21) < 6)
    r, c = np.unravel_index(np.where(cand, uniform_filter(s, 41), -1e9).argmax(), s.shape)
    return [float(v) for v in L["surf"].rc_to_xy(r, c)]
SPOT_SPACING_M = 30.0
SPOT_HALF_M = 1200.0          # candidate spots cover +-1.2 km around the aim point
EPHEM_START = "2026-11-15T00:00:00"
EPHEM_DAYS = 365
EPHEM_STEP_MIN = 10.0


def hillshade(z, res, az=135.0, alt=10.0):
    gy, gx = np.gradient(z, res)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    a, e = np.radians(az), np.radians(alt)
    s = np.sin(e) * np.cos(slope) + np.cos(e) * np.sin(slope) * np.cos(a - aspect)
    return np.clip(s, 0, 1)


def build(site, far):
    t0 = time.time()
    SITE = {"id": site, **SITES[site]}
    out = ROOT / "web/data" / site.lower()
    out.mkdir(parents=True, exist_ok=True)

    L = site_layers(site)
    near = L["surf"]
    ax, ay = SITE["aim_xy"] = pick_aim(L)
    print(f"== {site} ({SITE['name']}): aim x={ax:.1f} y={ay:.1f}")

    # --- candidate landing spots on a regular grid around the aim point --------------------
    offs = np.arange(-SPOT_HALF_M, SPOT_HALF_M + 0.1, SPOT_SPACING_M)
    OX, OY = np.meshgrid(offs, offs[::-1])            # row 0 = north edge
    sx, sy = ax + OX.ravel(), ay + OY.ravel()

    print(f"horizons for {sx.size} spots ...")
    H = horizon_masks(sx, sy, near, far)
    print(f"  done in {time.time() - t0:.1f}s, range {H.min():.2f} .. {H.max():.2f} deg")

    def sample(grid, xs, ys):
        r, c = grid.xy_to_rc(xs, ys)
        return grid.data[np.round(r).astype(int), np.round(c).astype(int)]

    slope = sample(L["slp"], sx, sy)
    toterr = sample(L["toterr"], sx, sy)
    # distance (m) from each pixel to the nearest pixel holding a real LOLA laser shot
    gap_grid = distance_transform_edt(L["ldec"].data <= 0) * near.res
    r, c = near.xy_to_rc(sx, sy)
    gap = gap_grid[np.round(r).astype(int), np.round(c).astype(int)]

    # --- Sun / Earth for one year (direction is the same for every spot to < 0.001 deg) ----
    lat, lon = xy_to_latlon(ax, ay)
    h_aim = float(ground_height(ax, ay, near, far)[0])
    times = utc_times(utc(EPHEM_START), EPHEM_DAYS, EPHEM_STEP_MIN)
    print(f"ephemeris for {len(times)} times ...")
    E = az_el(lat, lon, h_aim + OBSERVER_HEIGHT_M, times)
    eph = np.stack([E["SUN"][0], E["SUN"][1], E["EARTH"][0], E["EARTH"][1]], axis=1).astype("<f4")

    # --- write binaries --------------------------------------------------------------------
    eph.tofile(out / "ephem.bin")
    np.round(H * 100).astype("<i2").tofile(out / "horizon.bin")
    np.stack([OX.ravel(), OY.ravel(), slope, toterr, gap], axis=1).astype("<f4").tofile(out / "spots.bin")

    # --- hillshade of the analysis area (+ margin) -------------------------------------------
    pad = SPOT_HALF_M + 300
    r0, c0 = near.xy_to_rc(ax - pad, ay + pad)
    r1, c1 = near.xy_to_rc(ax + pad, ay - pad)
    r0, c0, r1, c1 = (int(round(v)) for v in (r0, c0, r1, c1))
    z = near.data[r0:r1 + 1, c0:c1 + 1]
    img = (40 + 215 * hillshade(z, near.res)).astype("uint8")
    Image.fromarray(img).save(out / "hillshade.png")
    hs_left, hs_top = near.rc_to_xy(r0 - 0.5, c0 - 0.5)

    validation = {}
    vpath = ROOT / f"data/validation/horizons_{site.lower()}.json"
    try:   # needs internet; keeps the last saved result if offline
        from validate_horizons import main as validate
        validate(float(lat), float(lon), h_aim + OBSERVER_HEIGHT_M, out_name=vpath.name)
    except Exception as e:  # noqa: BLE001
        print(f"  JPL Horizons check skipped: {e}")
    if vpath.exists():
        v = json.loads(vpath.read_text())
        validation = {b: {k: v["bodies"][b][k] for k in ("n", "max_abs_daz_deg", "max_abs_del_deg")}
                      for b in v["bodies"]}

    meta = {
        "site": {**SITE, "aim_latlon": [round(float(lat), 5), round(float(lon), 5)],
                 "aim_height_m": round(h_aim, 1)},
        "spots": {"n": int(sx.size), "cols": int(offs.size), "rows": int(offs.size),
                  "spacing_m": SPOT_SPACING_M, "half_m": SPOT_HALF_M,
                  "fields": ["x_off_m", "y_off_m", "slope_deg", "toterr_m", "gap_m"]},
        "horizon": {"az_step_deg": AZ_STEP_DEG, "n_az": H.shape[1], "unit": "centi-degrees",
                    "max_distance_km": MAX_DISTANCE_M / 1000, "observer_height_m": OBSERVER_HEIGHT_M},
        "ephem": {"start_utc": EPHEM_START + "Z", "step_min": EPHEM_STEP_MIN, "n": len(times),
                  "fields": ["sun_az", "sun_el", "earth_az", "earth_el"],
                  "source": "NAIF SPICE: DE421 + moon_pa_de421, frame MOON_ME, LT+S"},
        "hillshade": {"left": hs_left, "top": hs_top, "res": near.res, "aim_xy": [ax, ay],
                      "width": int(img.shape[1]), "height": int(img.shape[0])},
        "validation_vs_jpl_horizons": validation,
        "sources": [
            "NASA GSFC PGDA Product 78 (Barker et al. 2021): LOLA 5 m/px DEM, slope, uncertainty, LDEC",
            "LRO LOLA GDR LDEM_75S_120M (far-field terrain beyond the 5 m tile)",
            "NAIF SPICE kernels (DE421, MOON_ME); checked against NASA JPL Horizons",
        ],
        "assumptions": [
            "Sun and Earth count as visible when their center is above the terrain horizon (Sun disk radius is ~0.27 deg).",
            f"Observer {OBSERVER_HEIGHT_M:.0f} m above ground; horizon from terrain out to {MAX_DISTANCE_M / 1000:.0f} km, 1 deg azimuth steps.",
            "Solar visibility, not power generated. Geometric Earth visibility, not link quality.",
            "Landing drift is a circular, uniform disk around the aim point. Drift is an input, not a prediction.",
            "Terrain at 5 m/px: rocks and craters smaller than ~10 m are not visible to the tool.",
            "Weakly constrained terrain = far from any real LOLA laser shot (interpolated heights).",
            "The demo aim point is chosen by us (highest gently sloped spot in the tile), not an official mission target.",
        ],
        "built_in_s": round(time.time() - t0, 1),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"wrote {out} in {time.time() - t0:.1f}s")
    for f in sorted(out.iterdir()):
        print(f"  {f.name:15s} {f.stat().st_size / 1e6:6.2f} MB")
    return {"id": site, "dir": f"data/{site.lower()}/", "name": SITE["name"],
            "description": SITE["description"], "source": "NASA GSFC PGDA Product 78, " + SITE["pgda_label"],
            "aim_latlon": meta["site"]["aim_latlon"], "aim_height_m": meta["site"]["aim_height_m"]}


def main(sites):
    far = far_dem()
    index_path = ROOT / "web/data/sites.json"
    index = {s["id"]: s for s in json.loads(index_path.read_text())} if index_path.exists() else {}
    for site in sites:
        index[site] = build(site, far)
    order = [s for s in SITES if s in index]
    index_path.write_text(json.dumps([index[s] for s in order], indent=1))
    print(f"site list: {order}")


if __name__ == "__main__":
    main(sys.argv[1:] or list(SITES))
