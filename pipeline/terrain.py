"""Terrain layer: load the LOLA DEMs and convert between lat/lon and polar-stereographic x/y.

Both DEMs share one projection: south polar stereographic, sphere R = 1737.4 km,
heights in meters relative to that sphere (MOON_ME frame, DE421).
"""
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio

R_MOON = 1737400.0
ROOT = Path(__file__).resolve().parents[1]
PGDA = ROOT / "data/raw/pgda78"
GDR_FAR = ROOT / "data/raw/lola_gdr/LDEM_75S_120M.LBL"


@dataclass
class Grid:
    """A raster in polar-stereographic meters. Pixel (r, c) center is at
    x = left + (c + 0.5) * res,  y = top - (r + 0.5) * res."""
    data: np.ndarray      # float64 [rows, cols], NaN = no data
    left: float
    top: float
    res: float

    @property
    def shape(self):
        return self.data.shape

    def xy_to_rc(self, x, y):
        return (self.top - y) / self.res - 0.5, (x - self.left) / self.res - 0.5

    def rc_to_xy(self, r, c):
        return self.left + (c + 0.5) * self.res, self.top - (r + 0.5) * self.res

    def bounds(self):
        rows, cols = self.shape
        return self.left, self.top - rows * self.res, self.left + cols * self.res, self.top


def read_grid(path, scale_to_float=True) -> Grid:
    with rasterio.open(path) as d:
        a = d.read(1).astype("float64")
        if d.nodata is not None and not np.isnan(d.nodata):
            a[a == d.nodata] = np.nan
        if scale_to_float:
            a = a * d.scales[0]   # GDR IMG: DN * 0.5 = height (m); offset is the 1737.4 km sphere
        b = d.bounds
        assert abs(d.res[0] - d.res[1]) < 1e-9
        return Grid(a, b.left, b.top, d.res[0])


def site_layers(site: str):
    """All PGDA 78 layers for one site, on the same 5 m grid."""
    out = {}
    for code in ["surf", "slp", "slperr", "toterr", "ldec"]:
        p = PGDA / site / f"{site}_final_adj_5mpp_{code}.tif"
        if p.exists():
            out[code] = read_grid(p, scale_to_float=False)
    return out


def far_dem() -> Grid:
    return read_grid(GDR_FAR, scale_to_float=True)


# --- projection helpers (south polar stereographic on a sphere, k0 = 1) -------------------

def latlon_to_xy(lat_deg, lon_deg):
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    rho = 2 * R_MOON * np.tan(np.pi / 4 + lat / 2)
    return rho * np.sin(lon), rho * np.cos(lon)


def xy_to_latlon(x, y):
    rho = np.hypot(x, y)
    lat = 2 * np.arctan(rho / (2 * R_MOON)) - np.pi / 2
    lon = np.arctan2(x, y)
    return np.degrees(lat), np.degrees(lon)


def unit_vector(lat_deg, lon_deg):
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    return np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)])
