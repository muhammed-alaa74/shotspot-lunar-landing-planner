"""Horizon engine: for an observer, the terrain elevation angle in every azimuth.

Method (Mazarico et al. 2011): march outward along each azimuth over the Moon's surface,
sample the DEM, and keep the maximum elevation angle of the terrain seen from the observer.
Geometry is exact 3-D on a sphere (curvature included), not the small-angle d^2/2R formula.

Azimuth convention: degrees clockwise from local north (north = toward the lunar north pole).
Near field uses the 5 m PGDA tile; anything outside it uses the 120 m polar GDR.
"""
import math

import numpy as np
from numba import njit, prange

from terrain import R_MOON, Grid

OBSERVER_HEIGHT_M = 2.0        # solar panel / antenna height above ground (documented assumption)
MAX_DISTANCE_M = 250_000.0     # beyond ~250 km curvature hides even 10 km relief at these angles
AZ_STEP_DEG = 1.0


def ray_distances(max_d=MAX_DISTANCE_M, d0=5.0, growth=0.005):
    """5 m steps near the observer, then steps growing as 0.5 % of distance."""
    out = []
    d = d0
    while d <= max_d:
        out.append(d)
        d += max(d0, d * growth)
    return np.array(out)


@njit(cache=True, inline="always")
def _bilinear(a, left, top, res, x, y):
    r = (top - y) / res - 0.5
    c = (x - left) / res - 0.5
    rows, cols = a.shape
    if r < 0.0 or c < 0.0 or r > rows - 1.0 or c > cols - 1.0:
        return np.nan
    r0 = int(r)
    c0 = int(c)
    if r0 == rows - 1:
        r0 -= 1
    if c0 == cols - 1:
        c0 -= 1
    fr = r - r0
    fc = c - c0
    return (a[r0, c0] * (1 - fr) * (1 - fc) + a[r0, c0 + 1] * (1 - fr) * fc
            + a[r0 + 1, c0] * fr * (1 - fc) + a[r0 + 1, c0 + 1] * fr * fc)


@njit(cache=True, inline="always")
def _height(near, nl, nt, nr, far, fl, ft, fr, x, y):
    h = _bilinear(near, nl, nt, nr, x, y)
    if np.isnan(h):
        h = _bilinear(far, fl, ft, fr, x, y)
    return h


@njit(parallel=True, cache=True)
def _horizons(ox, oy, obs_h, az_rad, dists,
              near, nl, nt, nr, far, fl, ft, fr):
    R = R_MOON
    n_obs = ox.shape[0]
    n_az = az_rad.shape[0]
    out = np.full((n_obs, n_az), np.nan)
    for i in prange(n_obs):
        # observer unit vector from stereographic x, y
        rho = math.hypot(ox[i], oy[i])
        lat = 2.0 * math.atan(rho / (2.0 * R)) - math.pi / 2.0
        lon = math.atan2(ox[i], oy[i])
        cl = math.cos(lat)
        ux, uy, uz = cl * math.cos(lon), cl * math.sin(lon), math.sin(lat)
        # local east = z x up, north = up x east
        ex, ey = -uy, ux
        en = math.hypot(ex, ey)
        ex, ey, ez = ex / en, ey / en, 0.0
        nx = uy * ez - uz * ey
        ny = uz * ex - ux * ez
        nz = ux * ey - uy * ex
        h0 = _height(near, nl, nt, nr, far, fl, ft, fr, ox[i], oy[i])
        ro = R + h0 + obs_h
        Ox, Oy, Oz = ro * ux, ro * uy, ro * uz
        for k in range(n_az):
            ca, sa = math.cos(az_rad[k]), math.sin(az_rad[k])
            tx, ty, tz = ca * nx + sa * ex, ca * ny + sa * ey, ca * nz + sa * ez
            best = -math.pi / 2
            for j in range(dists.shape[0]):
                th = dists[j] / R
                ct, st = math.cos(th), math.sin(th)
                px, py, pz = ct * ux + st * tx, ct * uy + st * ty, ct * uz + st * tz
                q = px * px + py * py
                s = 2.0 * R * (1.0 + pz) / q
                x, y = s * py, s * px
                h = _height(near, nl, nt, nr, far, fl, ft, fr, x, y)
                if np.isnan(h):
                    continue
                rt = R + h
                vx, vy, vz = rt * px - Ox, rt * py - Oy, rt * pz - Oz
                el = math.asin((vx * ux + vy * uy + vz * uz) / math.sqrt(vx * vx + vy * vy + vz * vz))
                if el > best:
                    best = el
            out[i, k] = best
    return np.degrees(out)


def horizon_masks(x, y, near: Grid, far: Grid, obs_h=OBSERVER_HEIGHT_M,
                  az_step=AZ_STEP_DEG, max_d=MAX_DISTANCE_M):
    """Horizon elevation (deg) for observers at stereographic (x, y). Returns [n_obs, n_az]."""
    az = np.radians(np.arange(0.0, 360.0, az_step))
    return _horizons(np.atleast_1d(np.asarray(x, float)), np.atleast_1d(np.asarray(y, float)),
                     float(obs_h), az, ray_distances(max_d),
                     near.data, near.left, near.top, near.res,
                     far.data, far.left, far.top, far.res)


def ground_height(x, y, near: Grid, far: Grid):
    return np.array([_height(near.data, near.left, near.top, near.res,
                             far.data, far.left, far.top, far.res, xi, yi)
                     for xi, yi in zip(np.atleast_1d(x), np.atleast_1d(y))])
