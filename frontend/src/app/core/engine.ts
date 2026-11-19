// SHOTSPOT decision engine (layer 4), ported from web/app.js.
// No science is invented here: horizons and Sun/Earth angles come from pipeline/*.py
// (precomputed into web/data/<site>/). Every function takes the site data explicitly.

export interface SiteEntry {
  id: string; dir: string; name: string; description: string; source: string;
  aim_latlon: [number, number]; aim_height_m: number;
}
export interface SiteData {
  entry: SiteEntry; M: any;
  EPH: Float32Array; HZ: Int16Array; SP: Float32Array; img: ImageBitmap;
  N: number; COLS: number; STEP_MS: number; T0: number; defaultAim: number;
  cache: Map<string, Stats>;
}
export interface Profile { minSun: number; minEarth: number; maxSunGap: number; maxEarthGap: number; maxSlope: number; conservative: boolean; }
export interface Stats { sun: Float32Array; earth: Float32Array; sunGap: Float32Array; earthGap: Float32Array; }
export interface Reason { ok: boolean; warn?: boolean; label: string; value: number; dir: '≥' | '≤'; needNum: number; need: string; unit: string; d: number; }
export interface Verdict { pass: boolean; reasons: Reason[]; weak: boolean; }
export interface Vis { sun: Uint8Array; ear: Uint8Array; }
export interface Spot { x: number; y: number; slope: number; toterr: number; gap: number; }

export const WEAK_GAP_M = 20; // farther than this from a real LOLA shot = weakly constrained
export const R_MOON = 1737400;

// ---------------------------------------------------------------- formatting
export const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');
export const iso = (t: Date) => t.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
export const latlonStr = (lat: number, lon: number, d = 3) =>
  `${Math.abs(lat).toFixed(d)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(d)}°${lon < 0 ? 'W' : 'E'}`;
export const dur = (ms: number) => { const h = ms / 3.6e6; return h >= 48 ? `${fmt(h / 24)} days` : `${fmt(h)} h`; };

// ---------------------------------------------------------------- loading
async function bin<T>(url: string, Type: new (b: ArrayBuffer) => T): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Type(await r.arrayBuffer());
}
export async function loadAll(base = 'data/'): Promise<SiteData[]> {
  const r = await fetch(base + 'sites.json');
  if (!r.ok) throw new Error(`${base}sites.json: HTTP ${r.status}`);
  const list: SiteEntry[] = await r.json();
  return Promise.all(list.map(async (entry) => {
    const dir = base + entry.dir.replace(/^data\//, '');
    const M = await (await fetch(dir + 'meta.json')).json();
    const [EPH, HZ, SP] = await Promise.all([bin(dir + 'ephem.bin', Float32Array), bin(dir + 'horizon.bin', Int16Array), bin(dir + 'spots.bin', Float32Array)]);
    // createImageBitmap instead of Image.decode(): decode() can stall in background tabs
    const img = await createImageBitmap(await (await fetch(dir + 'hillshade.png')).blob());
    const N = M.spots.n;
    return { entry, M, EPH, HZ, SP, img, N, COLS: M.spots.cols, STEP_MS: M.ephem.step_min * 60000,
      T0: Date.parse(M.ephem.start_utc), defaultAim: (N - 1) / 2, cache: new Map() } as SiteData;
  }));
}

// ---------------------------------------------------------------- engine helpers
export const hzAt = (d: SiteData, k: number, az: number) => {
  const i = Math.floor(az) % 360, f = az - Math.floor(az), b = k * 360;
  return (d.HZ[b + i] * (1 - f) + d.HZ[b + ((i + 1) % 360)] * f) / 100;
};
export const eph = (d: SiteData, j: number) => { const b = 4 * j; return { sa: d.EPH[b], se: d.EPH[b + 1], ea: d.EPH[b + 2], ee: d.EPH[b + 3] }; };
export const spot = (d: SiteData, k: number): Spot => { const b = 5 * k; return { x: d.SP[b], y: d.SP[b + 1], slope: d.SP[b + 2], toterr: d.SP[b + 3], gap: d.SP[b + 4] }; };
/** Distance between two analysis spots; coordinates are relative to the site's aim origin. */
export const spotDistance = (d: SiteData, a: number, b: number) => {
  const first = spot(d, a), second = spot(d, b);
  return Math.hypot(first.x - second.x, first.y - second.y);
};
export const idxTime = (d: SiteData, j: number) => new Date(d.T0 + j * d.STEP_MS);

function computeStats(d: SiteData, s0: number, n: number): Stats {
  const { EPH, HZ, N } = d;
  const sunI = new Uint16Array(n), sunF = new Float32Array(n), earI = new Uint16Array(n), earF = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const e = eph(d, s0 + j);
    sunI[j] = Math.floor(e.sa) % 360; sunF[j] = e.sa - Math.floor(e.sa);
    earI[j] = Math.floor(e.ea) % 360; earF[j] = e.ea - Math.floor(e.ea);
  }
  const out: Stats = { sun: new Float32Array(N), earth: new Float32Array(N), sunGap: new Float32Array(N), earthGap: new Float32Array(N) };
  const h = d.STEP_MS / 3600000;
  for (let k = 0; k < N; k++) {
    const b = k * 360;
    let ns = 0, ne = 0, rs = 0, re = 0, gs = 0, ge = 0;
    for (let j = 0; j < n; j++) {
      const b4 = 4 * (s0 + j);
      const i = sunI[j], f = sunF[j];
      const hs = (HZ[b + i] * (1 - f) + HZ[b + ((i + 1) % 360)] * f) / 100;
      if (EPH[b4 + 1] > hs) { ns++; rs = 0; } else if (++rs > gs) gs = rs;
      const i2 = earI[j], f2 = earF[j];
      const he = (HZ[b + i2] * (1 - f2) + HZ[b + ((i2 + 1) % 360)] * f2) / 100;
      if (EPH[b4 + 3] > he) { ne++; re = 0; } else if (++re > ge) ge = re;
    }
    out.sun[k] = (100 * ns) / n; out.earth[k] = (100 * ne) / n;
    out.sunGap[k] = gs * h; out.earthGap[k] = ge * h;
  }
  return out;
}
/** Cached per site, so changing the profile or drift never redoes the heavy part. */
export function statsFor(d: SiteData, s0: number, n: number): Stats {
  const key = `${s0}:${n}`, c = d.cache;
  if (!c.has(key)) { if (c.size > 12) c.clear(); c.set(key, computeStats(d, s0, n)); }
  return c.get(key)!;
}

/** One verdict function for every spot; every reason carries the numbers it is based on. */
export function verdict(d: SiteData, k: number, st: Stats, p: Profile): Verdict {
  const s = spot(d, k), r: Reason[] = [];
  const add = (ok: boolean, label: string, value: number, dir: '≥' | '≤', needNum: number, unit: string, dd = 1) =>
    r.push({ ok, label, value, dir, needNum, need: `${dir} ${needNum}`, unit, d: dd });
  add(st.sun[k] >= p.minSun, 'Sunlight', st.sun[k], '≥', p.minSun, '%');
  add(st.earth[k] >= p.minEarth, 'Earth visibility', st.earth[k], '≥', p.minEarth, '%');
  add(st.sunGap[k] <= p.maxSunGap, 'Longest dark period', st.sunGap[k], '≤', p.maxSunGap, 'h');
  add(st.earthGap[k] <= p.maxEarthGap, 'Longest Earth outage', st.earthGap[k], '≤', p.maxEarthGap, 'h');
  add(s.slope <= p.maxSlope, 'Slope', s.slope, '≤', p.maxSlope, '°');
  const weak = s.gap > WEAK_GAP_M;
  r.push({ ok: !(weak && p.conservative), warn: weak, label: 'Terrain data', value: s.gap, dir: '≤', needNum: WEAK_GAP_M, need: `nearest laser shot ≤ ${WEAK_GAP_M} m`, unit: 'm', d: 0 });
  return { pass: r.every((x) => x.ok), reasons: r, weak };
}
/** signed margin to the limit: positive = room left, negative = missed by that much */
export const margin = (r: Reason) => (r.dir === '≥' ? r.value - r.needNum : r.needNum - r.value);
/** plain-language reason built only from the engine numbers */
export function reasonText(r: Reason): string {
  if (r.label === 'Terrain data') return `the nearest real laser measurement is ${fmt(r.value, 0)} m away (limit ${WEAK_GAP_M} m), so heights here are interpolated`;
  return `${r.label.toLowerCase()} is ${fmt(r.value, r.d)} ${r.unit}, required ${r.need} ${r.unit} (${r.dir === '≥' ? 'short' : 'over'} by ${fmt(Math.abs(margin(r)), r.d)} ${r.unit})`;
}
export function passFor(d: SiteData, st: Stats, p: Profile): Uint8Array {
  const g = new Uint8Array(d.N); for (let k = 0; k < d.N; k++) g[k] = verdict(d, k, st, p).pass ? 1 : 0; return g;
}

// ---------------------------------------------------------------- dispersion: uniform drift disk
export function diskOffsets(d: SiteData, r: number): [number, number][] {
  const sp = d.M.spots.spacing_m, n = Math.floor(r / sp), out: [number, number][] = [];
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx * dx + dy * dy) * sp * sp <= r * r) out.push([dx, dy]);
  return out;
}
/** fraction of acceptable spots in a uniform drift disk around spot `a` (NaN if the disk leaves the grid) */
export function share(d: SiteData, a: number, offs: [number, number][], pg: Uint8Array): number {
  const C = d.COLS, ac = a % C, ar = Math.floor(a / C); let ok = 0, tot = 0;
  for (const [dx, dy] of offs) { const c = ac + dx, rr = ar + dy; if (c < 0 || rr < 0 || c >= C || rr >= C) return NaN; tot++; ok += pg[rr * C + c]; }
  return tot ? ok / tot : NaN;
}
export function bestAim(d: SiteData, r: number, pg: Uint8Array, aim: number) {
  const offs = diskOffsets(d, r); let best = -1, bk = -1;
  const nominal = share(d, aim, offs, pg);
  for (let k = 0; k < d.N; k++) { const v = share(d, k, offs, pg); if (v > best + 1e-9) { best = v; bk = k; } }
  return { k: bk, share: best, nominal };
}
export interface CurvePt { r: number; best: number; nominal: number; k: number; }
export function dispersionCurve(d: SiteData, pg: Uint8Array, aim: number): CurvePt[] {
  const out: CurvePt[] = [];
  for (let r = 0; r <= 500; r += 25) { const b = bestAim(d, r, pg, aim); out.push({ r, best: b.share, nominal: b.nominal, k: b.k }); }
  return out;
}
/** smallest drift at which the best aim for a precise landing (25 m) stops being the best choice */
export function flipPoint(d: SiteData, curve: CurvePt[]): CurvePt | null {
  const ref = curve[1]?.k ?? -1;
  if (ref < 0) return null;
  return curve.find((c) => c.r > 25 && c.k !== ref && Math.hypot(spot(d, c.k).x - spot(d, ref).x, spot(d, c.k).y - spot(d, ref).y) > 2 * d.M.spots.spacing_m) ?? null;
}

// ---------------------------------------------------------------- visibility series and windows
export function visSeries(d: SiteData, k: number, s0: number, n: number): Vis {
  const sun = new Uint8Array(n), ear = new Uint8Array(n);
  for (let j = 0; j < n; j++) { const e = eph(d, s0 + j); sun[j] = e.se > hzAt(d, k, e.sa) ? 1 : 0; ear[j] = e.ee > hzAt(d, k, e.ea) ? 1 : 0; }
  return { sun, ear };
}
/** [start, end) sample indices where arr is 1 */
export function runs(arr: Uint8Array): [number, number][] {
  const out: [number, number][] = []; let s = -1;
  for (let j = 0; j <= arr.length; j++) { const v = j < arr.length && arr[j]; if (v && s < 0) s = j; if (!v && s >= 0) { out.push([s, j]); s = -1; } }
  return out;
}
/** time (ms) when visibility flips after the cursor, interpolated between samples */
export function nextChange(d: SiteData, k: number, which: 'sun' | 'earth', vs: Vis, cursor: number, s0: number, n: number) {
  const arr = which === 'sun' ? vs.sun : vs.ear, ai = which === 'sun' ? 0 : 2, ei = ai + 1, c = cursor;
  for (let j = c + 1; j < n; j++) if (arr[j] !== arr[c]) {
    const m = (i: number) => { const b = 4 * (s0 + i); return d.EPH[b + ei] - hzAt(d, k, d.EPH[b + ai]); };
    const m0 = m(j - 1), m1 = m(j), f = m0 === m1 ? 0 : m0 / (m0 - m1);
    return { ms: (j - 1 - c + Math.min(Math.max(f, 0), 1)) * d.STEP_MS, to: arr[j] };
  }
  return null;
}

// ---------------------------------------------------------------- coordinates
export function latlonToXY(lat: number, lon: number): [number, number] {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180, rho = 2 * R_MOON * Math.tan(Math.PI / 4 + la / 2);
  return [rho * Math.sin(lo), rho * Math.cos(lo)];
}
export function xyToLatlon(x: number, y: number): [number, number] {
  const rho = Math.hypot(x, y);
  return [((2 * Math.atan(rho / (2 * R_MOON)) - Math.PI / 2) * 180) / Math.PI, (Math.atan2(x, y) * 180) / Math.PI];
}
export function spotLatlon(d: SiteData, k: number): [number, number] {
  const s = spot(d, k), [ax, ay] = d.M.site.aim_xy; return xyToLatlon(ax + s.x, ay + s.y);
}
/** find which site's precomputed area contains a point, and the nearest analysis spot */
export function locate(sites: SiteData[], lat: number, lon: number) {
  const [x, y] = latlonToXY(lat, lon);
  let nearest: { d: SiteData; dist: number } | null = null;
  for (const d of sites) {
    const [ax, ay] = d.M.site.aim_xy, h = d.M.spots.half_m, sp = d.M.spots.spacing_m, dx = x - ax, dy = y - ay, dist = Math.hypot(dx, dy);
    if (!nearest || dist < nearest.dist) nearest = { d, dist };
    if (Math.abs(dx) <= h && Math.abs(dy) <= h) {
      const c = Math.round((dx + h) / sp), r = Math.round((h - dy) / sp);
      return { hit: { d, k: r * d.COLS + c, snap: Math.hypot(dx - (-h + c * sp), dy - (h - r * sp)) }, nearest };
    }
  }
  return { hit: null, nearest };
}
