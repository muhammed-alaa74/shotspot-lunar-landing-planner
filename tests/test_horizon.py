"""Synthetic-terrain tests for the horizon engine (team acceptance: flat plane, known ridge)."""
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))
from horizon import horizon_masks  # noqa: E402
from terrain import R_MOON, Grid, latlon_to_xy  # noqa: E402

RES = 20.0
HALF = 20_000.0        # synthetic tile: 40 x 40 km
OBS_LAT, OBS_LON = -85.4, 31.7


def _grid(fn):
    """Build a synthetic 'near' DEM around the observer; height = fn(distance from observer)."""
    ox, oy = latlon_to_xy(OBS_LAT, OBS_LON)
    n = int(2 * HALF / RES)
    left, top = ox - HALF, oy + HALF
    cx = left + (np.arange(n) + 0.5) * RES
    cy = top - (np.arange(n) + 0.5) * RES
    X, Y = np.meshgrid(cx, cy)
    d = np.hypot(X - ox, Y - oy)          # stereographic distortion here is ~0.2 %, fine for tests
    return Grid(fn(d).astype(float), left, top, RES), ox, oy


def _empty_far():
    return Grid(np.full((2, 2), np.nan), 0.0, 0.0, 1.0)


def test_flat_sphere_horizon_is_just_below_zero():
    near, ox, oy = _grid(lambda d: np.zeros_like(d))
    h = horizon_masks(ox, oy, near, _empty_far(), obs_h=2.0, max_d=19_000)
    # a bare sphere seen from 2 m: the max over samples is the nearest sample, a hair below 0
    assert np.all(h < 0.0)
    assert np.all(h > -0.1)


def test_ring_wall_100m_at_4km_matches_formula():
    near, ox, oy = _grid(lambda d: np.where((d >= 4000) & (d <= 4100), 100.0, 0.0))
    h = horizon_masks(ox, oy, near, _empty_far(), obs_h=0.0, max_d=19_000)
    d = 4000.0
    expected = math.degrees(math.atan((100.0 - d * d / (2 * R_MOON)) / d))   # team formula, 1.366 deg
    assert abs(np.median(h) - expected) < 0.03, (np.median(h), expected)
    assert np.ptp(h) < 0.1     # same in every azimuth


def test_no_curvature_value_is_1_43_deg_only_without_curvature():
    # sanity check of the number quoted in the vision doc (1.43 deg ignores curvature)
    assert abs(math.degrees(math.atan(100 / 4000)) - 1.432) < 0.001
