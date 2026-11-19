"""Sun and Earth azimuth/elevation for an observer on the Moon, from NAIF SPICE.

Frame: MOON_ME (DE421 mean Earth / polar axis), the same frame the LOLA DEMs use.
Corrections: light time + stellar aberration ('LT+S'). Positions are taken from the observer,
not the Moon's center (Earth parallax from the surface is ~0.25 deg, not negligible).
Azimuth: clockwise from local north (toward the lunar north pole), same as horizon.py.
"""
from datetime import datetime, timedelta, timezone

import numpy as np
import spiceypy as sp

from terrain import ROOT, R_MOON, unit_vector

KERNELS = ["naif0012.tls", "de421.bsp", "moon_pa_de421_1900-2050.bpc", "moon_080317.tf", "pck00010.tpc"]
_loaded = False


def _load():
    global _loaded
    if not _loaded:
        for k in KERNELS:
            sp.furnsh(str(ROOT / "data/spice" / k))
        _loaded = True


def utc_times(start: datetime, days: float, step_min: float):
    n = int(round(days * 24 * 60 / step_min))
    return [start + timedelta(minutes=step_min * i) for i in range(n + 1)]


def az_el(lat_deg, lon_deg, height_m, times):
    """Returns dict body -> (az_deg[n], el_deg[n]) for 'SUN' and 'EARTH'."""
    _load()
    up = unit_vector(lat_deg, lon_deg)
    east = np.cross([0.0, 0.0, 1.0], up)
    east /= np.linalg.norm(east)
    north = np.cross(up, east)
    site_km = up * (R_MOON + height_m) / 1000.0
    ets = np.array([sp.str2et(t.strftime("%Y-%m-%dT%H:%M:%S")) for t in times])
    out = {}
    for body in ["SUN", "EARTH"]:
        az = np.empty(len(ets))
        el = np.empty(len(ets))
        for i, et in enumerate(ets):
            # body position seen from the Moon's center, then shifted to the surface site
            p, _ = sp.spkpos(body, et, "MOON_ME", "LT+S", "MOON")
            v = np.asarray(p) - site_km
            v /= np.linalg.norm(v)
            el[i] = np.degrees(np.arcsin(v @ up))
            az[i] = np.degrees(np.arctan2(v @ east, v @ north)) % 360.0
        out[body] = (az, el)
    return out


def utc(s: str) -> datetime:
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
