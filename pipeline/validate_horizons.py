"""Compare our SPICE Sun/Earth angles with NASA JPL Horizons (team acceptance: |diff| <= 0.01 deg).

Usage: python pipeline/validate_horizons.py [lat lon height_m start_utc]
Writes data/validation/horizons_check.json.
"""
import json
import sys
from datetime import timedelta

import numpy as np
import requests

from ephemeris import az_el, utc
from terrain import ROOT

API = "https://ssd.jpl.nasa.gov/api/horizons.api"


def horizons(body_id, lat, lon, h_m, start, stop, step):
    q = {
        "format": "json", "COMMAND": f"'{body_id}'", "MAKE_EPHEM": "YES", "EPHEM_TYPE": "OBSERVER",
        "CENTER": "'coord@301'", "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon % 360:.6f},{lat:.6f},{h_m / 1000:.4f}'",
        "START_TIME": f"'{start}'", "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{step}'",
        "QUANTITIES": "'4'", "ANG_FORMAT": "DEG", "CSV_FORMAT": "YES", "APPARENT": "AIRLESS",
        "TIME_DIGITS": "MINUTES",
    }
    r = requests.get(API, params=q, timeout=60)
    r.raise_for_status()
    text = r.json()["result"]
    body = text.split("$$SOE")[1].split("$$EOE")[0]
    rows = []
    for line in body.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        rows.append((parts[0], float(parts[3]), float(parts[4])))
    return rows


def main(lat=-85.427, lon=31.743, h=5600.0, start="2026-12-01T00:00", out_name="horizons_check.json"):
    t0 = utc(start)
    times = [t0 + timedelta(hours=6 * i) for i in range(20)]       # 20 sample times over 5 days
    ours = az_el(lat, lon, h, times)
    report = {"site": {"lat": lat, "lon": lon, "height_m": h}, "bodies": {}}
    for body, hid in [("SUN", "10"), ("EARTH", "399")]:
        rows = horizons(hid, lat, lon, h, t0.strftime("%Y-%m-%d %H:%M"),
                        (times[-1] + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M"), "6 h")[:len(times)]
        az, el = ours[body]
        daz = np.array([((a - r[1] + 180) % 360) - 180 for a, r in zip(az, rows)])
        dele = np.array([e - r[2] for e, r in zip(el, rows)])
        report["bodies"][body] = {
            "n": len(rows), "max_abs_daz_deg": float(np.abs(daz).max()),
            "max_abs_del_deg": float(np.abs(dele).max()),
            "samples": [{"utc": r[0], "horizons_az": r[1], "horizons_el": r[2],
                         "ours_az": round(float(a), 4), "ours_el": round(float(e), 4)}
                        for r, a, e in zip(rows, az, el)],
        }
        print(f"{body}: max |d_az| = {np.abs(daz).max():.4f} deg, max |d_el| = {np.abs(dele).max():.4f} deg")
    out = ROOT / "data/validation" / out_name
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1))
    return report


if __name__ == "__main__":
    a = sys.argv[1:]
    main(*(map(float, a[:3])), *a[3:]) if a else main()
