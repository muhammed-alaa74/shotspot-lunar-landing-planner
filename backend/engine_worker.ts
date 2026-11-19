import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import {
  bestAim,
  diskOffsets,
  dispersionCurve,
  eph,
  flipPoint,
  hzAt,
  idxTime,
  passFor,
  R_MOON,
  reasonText,
  share,
  spot,
  spotLatlon,
  statsFor,
  verdict,
  visSeries,
  runs,
  type Profile,
  type SiteData,
} from '../frontend/src/app/core/engine';
import { arrivalShift, compare as nativeCompare, windows, type CmpRow } from '../frontend/src/app/core/analysis';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIRS = [
  process.env.SHOTSPOT_DATA_DIR,
  resolve(HERE, '../web/data'),
  resolve(HERE, '../ready-to-run/data'),
  resolve(HERE, '../frontend/dist/frontend/browser/data'),
].filter(Boolean) as string[];

const DEFAULT_PROFILE: Profile = {
  minSun: 40,
  minEarth: 50,
  maxSunGap: 72,
  maxEarthGap: 48,
  maxSlope: 8,
  conservative: false,
};
const VALID_TOOLS = new Set(['list_sites', 'get_baseline', 'compare', 'run_scenario', 'find_alternatives', 'dispersion']);
const GLOSSARY: Record<string, { term: string; definition: string; egyptian_arabic: string }> = {
  elevation: { term: 'elevation', definition: 'Angle above the local terrain horizon.', egyptian_arabic: 'زاوية الجسم فوق أفق التضاريس المحلي.' },
  azimuth: { term: 'azimuth', definition: 'Compass direction around the horizon, in degrees.', egyptian_arabic: 'اتجاه الجسم حوالين الأفق بالدرجات.' },
  horizon: { term: 'horizon', definition: 'The terrain elevation that can block a body at a given azimuth.', egyptian_arabic: 'ارتفاع التضاريس اللي ممكن يحجب الجسم في اتجاه معيّن.' },
  sunset: { term: 'sunset', definition: 'The native engine transition from Sun visible to not visible.', egyptian_arabic: 'لحظة انتقال الشمس من ظاهرة لغير ظاهرة حسب المحرك.' },
  earthset: { term: 'Earthset', definition: 'The native engine transition from Earth visible to not visible.', egyptian_arabic: 'لحظة انتقال الأرض من ظاهرة لغير ظاهرة حسب المحرك.' },
  libration: { term: 'libration', definition: 'The apparent rocking that changes the geometry of the lunar view over time.', egyptian_arabic: 'التمايل الظاهري اللي بيغيّر هندسة الرؤية من القمر مع الوقت.' },
  drift: { term: 'drift', definition: 'A user-supplied circular landing-radius input, not a prediction.', egyptian_arabic: 'نطاق دائري بيدخله المستخدم للهبوط، مش تنبؤ.' },
};

type AnyRecord = Record<string, any>;

function dataDir(): string {
  for (const candidate of DEFAULT_DATA_DIRS) {
    try {
      if (candidate && readFileSync(join(candidate, 'sites.json'), 'utf8')) return candidate;
    } catch { /* try the next repository data copy */ }
  }
  throw new Error('Native engine data could not be found');
}

function readTyped(path: string, kind: 'float' | 'short'): Float32Array | Int16Array {
  const bytes = readFileSync(path);
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return kind === 'float' ? new Float32Array(raw) : new Int16Array(raw);
}

function loadAllNative(base: string): SiteData[] {
  const list = JSON.parse(readFileSync(join(base, 'sites.json'), 'utf8')) as AnyRecord[];
  return list.map((entry) => {
    const dir = join(base, String(entry.dir).replace(/^data\//, ''));
    const M = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    const EPH = readTyped(join(dir, 'ephem.bin'), 'float') as Float32Array;
    const HZ = readTyped(join(dir, 'horizon.bin'), 'short') as Int16Array;
    const SP = readTyped(join(dir, 'spots.bin'), 'float') as Float32Array;
    const N = M.spots.n;
    // The browser loader creates an ImageBitmap, but no engine calculation reads it.
    const img = undefined as any;
    return {
      entry,
      M,
      EPH,
      HZ,
      SP,
      img,
      N,
      COLS: M.spots.cols,
      STEP_MS: M.ephem.step_min * 60000,
      T0: Date.parse(M.ephem.start_utc),
      defaultAim: (N - 1) / 2,
      cache: new Map(),
    } as SiteData;
  });
}

const SITES = loadAllNative(dataDir());
const SITE_NAMES = SITES.map((d) => d.entry.name);
const byId = new Map(SITES.map((d) => [d.entry.id.toLowerCase(), d]));

function finite(value: any): value is number { return typeof value === 'number' && Number.isFinite(value); }
function iso(d: Date): string { return d.toISOString(); }
function jsonNumber(value: any): any { return typeof value === 'number' && !Number.isFinite(value) ? null : value; }
function publicValue(value: any): any {
  if (typeof value === 'number') return jsonNumber(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Array.from(value as any, (v: any) => jsonNumber(v));
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') {
    const out: AnyRecord = {};
    for (const [key, child] of Object.entries(value)) out[key] = publicValue(child);
    return out;
  }
  return value;
}
function clone(value: any): any { return publicValue(JSON.parse(JSON.stringify(publicValue(value)))); }
function fail(message: string): never { throw new Error(message.replace(/[\r\n].*$/s, '').slice(0, 500)); }
function norm(value: any): string { return String(value ?? '').normalize('NFKD').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old;
    }
  }
  return row[b.length];
}
function siteOf(value: any): SiteData {
  if (typeof value !== 'string' || !value.trim()) fail(`site is required; valid names: ${SITE_NAMES.join(', ')}`);
  const key = norm(value);
  const direct = byId.get(key);
  if (direct) return direct;
  const exact = SITES.find((d) => norm(d.entry.name) === key);
  if (exact) return exact;
  const contained = SITES.filter((d) => norm(d.entry.name).includes(key) || key.includes(norm(d.entry.name)));
  if (contained.length === 1) return contained[0];
  const ranked = SITES.map((d) => ({ d, n: editDistance(key, norm(d.entry.name)) })).sort((a, b) => a.n - b.n);
  const limit = Math.max(2, Math.floor(key.replace(/ /g, '').length * 0.25));
  if (ranked[0] && ranked[0].n <= limit && (!ranked[1] || ranked[0].n < ranked[1].n)) return ranked[0].d;
  fail(`Unknown site '${String(value)}'. Valid site names: ${SITE_NAMES.join(', ')}`);
}
function dateValue(value: any, field = 'start_date'): Date {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} is required as an ISO UTC date`);
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : (/Z$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) fail(`${field} must be a valid ISO UTC date`);
  return new Date(t);
}
function numberArg(args: AnyRecord, names: string[], fallback: number | undefined, label: string): { value: number; usedDefault: boolean } {
  let value: any;
  let usedDefault = false;
  for (const name of names) if (args[name] !== undefined) { value = args[name]; break; }
  if (value === undefined) { if (fallback === undefined) fail(`${label} is required`); value = fallback; usedDefault = true; }
  if (!finite(value)) fail(`${label} must be a finite number`);
  return { value, usedDefault };
}
function integerArg(args: AnyRecord, names: string[], fallback: number | undefined, label: string): { value: number; usedDefault: boolean } {
  const x = numberArg(args, names, fallback, label);
  if (!Number.isInteger(x.value)) fail(`${label} must be an integer`);
  return x;
}
function profileOf(args: AnyRecord, context: AnyRecord | undefined, assumed: string[]): Profile {
  const supplied = args.profile ?? context?.profile;
  if (supplied === undefined) { assumed.push('profile'); return { ...DEFAULT_PROFILE }; }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) fail('profile must be an object');
  const out: AnyRecord = { ...DEFAULT_PROFILE, ...(context?.profile ?? {}), ...supplied };
  for (const key of ['minSun', 'minEarth']) if (!finite(out[key]) || out[key] < 0 || out[key] > 100) fail(`profile.${key} must be between 0 and 100`);
  for (const key of ['maxSunGap', 'maxEarthGap']) if (!finite(out[key]) || out[key] < 0 || out[key] > 24 * 365) fail(`profile.${key} must be between 0 and 8760`);
  if (!finite(out.maxSlope) || out.maxSlope < 0 || out.maxSlope > 90) fail('profile.maxSlope must be between 0 and 90');
  if (typeof out.conservative !== 'boolean') fail('profile.conservative must be boolean');
  return out as Profile;
}
function effectiveFor(args: AnyRecord, context: AnyRecord | undefined, tool: string, site: SiteData, assumed: string[]): AnyRecord {
  const contextDuration = context?.durationDays ?? context?.duration_days;
  const duration = numberArg(args, ['duration_days', 'durationDays'], contextDuration ?? 10, 'duration_days');
  if (duration.usedDefault && contextDuration === undefined) assumed.push('duration_days=10');
  if (duration.value <= 0 || duration.value > 365) fail('duration_days must be greater than 0 and no more than 365');
  const startRaw = args.start_date ?? args.startDate ?? context?.date ?? context?.start_date;
  let start: Date;
  if (startRaw === undefined) { start = new Date(site.T0); assumed.push('start_date=first_covered_date'); } else start = dateValue(startRaw);
  const n = Math.round((duration.value * 864e5) / site.STEP_MS) + 1;
  const s0 = Math.round((start.getTime() - site.T0) / site.STEP_MS);
  if (!Number.isInteger(s0) || s0 < 0 || s0 + n > site.M.ephem.n) {
    const first = iso(new Date(site.T0));
    const last = iso(new Date(site.T0 + (site.M.ephem.n - n) * site.STEP_MS));
    fail(`start_date and duration_days must fit native coverage for ${site.entry.name}: ${first} to ${last}`);
  }
  const contextDrift = context?.driftM ?? context?.drift_m;
  const drift = numberArg(args, ['drift_m', 'driftM'], contextDrift ?? 100, 'drift_m');
  if (drift.usedDefault && contextDrift === undefined) assumed.push('drift_m=100');
  if (drift.value < 0 || drift.value > 500) fail('drift_m must be between 0 and 500 m');
  const delay = numberArg(args, ['arrival_delay_days', 'arrivalDelayDays'], context?.arrivalDelayDays ?? 0, 'arrival_delay_days');
  if (delay.value < 0 || delay.value > 365) fail('arrival_delay_days must be between 0 and 365 days');
  const p = profileOf(args, context, assumed);
  const contextIsSameSite = context?.site && siteOf(context.site).entry.id === site.entry.id;
  const aimInput = args.aim_index ?? args.aimIndex ?? (contextIsSameSite ? context?.aimIndex : undefined);
  const aim = aimInput === undefined ? site.defaultAim : aimInput;
  if (!Number.isInteger(aim) || aim < 0 || aim >= site.N) fail(`aim_index must be an integer between 0 and ${site.N - 1}`);
  return {
    site: site.entry.id, site_name: site.entry.name, start_date: iso(start), duration_days: duration.value,
    drift_m: drift.value, arrival_delay_days: delay.value, aim_index: aim, profile: p,
    _site: site, _s0: s0, _n: n,
  };
}
function wrapper(tool: string, effective: AnyRecord, defaults: string[], body: AnyRecord): AnyRecord {
  const cleanEffective = { ...effective }; delete cleanEffective._site; delete cleanEffective._s0; delete cleanEffective._n;
  return publicValue({ tool, effective: cleanEffective, defaults_assumed: defaults, ...body });
}
function bodyProfile(e: AnyRecord): Profile { return e.profile as Profile; }
function nativeTime(d: SiteData, i: number): string { return idxTime(d, i).toISOString(); }
function round(value: any, digits: number): number | null {
  return finite(value) ? Number(value.toFixed(digits)) : null;
}
function conditions(d: SiteData, st: any, aim: number, p: Profile): AnyRecord[] {
  const v = verdict(d, aim, st, p);
  const margin = (r: any) => r.dir === '≥' ? r.value - r.needNum : r.needNum - r.value;
  return v.reasons.map((r: any) => ({ condition: r.label, value: round(r.value, 3), required: r.need, unit: r.unit, margin: round(margin(r), 3), ok: r.ok, warning: !!r.warn }));
}
function windowJson(d: SiteData, arr: Uint8Array, s0: number): AnyRecord[] {
  const stepMin = d.M.ephem.step_min;
  return runs(arr).map(([s, e]) => ({ start_utc: nativeTime(d, s0 + s), end_utc: nativeTime(d, s0 + e), minutes: (e - s) * stepMin }));
}
function aimPoint(d: SiteData, k: number): AnyRecord {
  const [lat, lon] = spotLatlon(d, k);
  return { index: k, offset_m: [spot(d, k).x, spot(d, k).y], latlon_deg: [round(lat, 5), round(lon, 5)] };
}
function dispersionJson(d: SiteData, pg: Uint8Array, aim: number, drift: number): AnyRecord {
  const b = bestAim(d, drift, pg, aim), bs = b.k >= 0 ? spot(d, b.k) : null, current = spot(d, aim), curve = dispersionCurve(d, pg, aim), flip = flipPoint(d, curve);
  return {
    acceptable_at_aim_pct: finite(b.nominal) ? round(100 * b.nominal, 1) : null,
    acceptable_at_best_aim_pct: finite(b.share) ? round(100 * b.share, 1) : null,
    best_aim_offset_m: bs ? [bs.x, bs.y] : null,
    best_aim_offset_reference: 'site grid origin',
    best_aim_relative_to_current_m: bs ? [bs.x - current.x, bs.y - current.y] : null,
    best_aim_movement_m: bs ? Math.hypot(bs.x - current.x, bs.y - current.y) : null,
    decision_flip_m: flip ? flip.r : null,
    decision_flip_description: 'first sampled crossover; rankings may change again',
    nominal_share: jsonNumber(b.nominal), best_share: jsonNumber(b.share), best_aim_index: b.k,
    curve: curve.map((x) => ({ ...x, best_pct: finite(x.best) ? 100 * x.best : null, nominal_pct: finite(x.nominal) ? 100 * x.nominal : null })),
    flip: flip ? { ...flip, from_index: curve[1]?.k ?? null, to_index: flip.k } : null,
  };
}
function dailySeries(d: SiteData, aim: number, s0: number, n: number, vs: any, p: Profile, st: any): AnyRecord[] {
  const step = d.M.ephem.step_min;
  const perDay = Math.max(1, Math.round(1440 / step));
  const out: AnyRecord[] = [];
  for (let start = 0; start < n; start += perDay) {
    const end = Math.min(n, start + perDay);
    const count = Math.max(1, end - start);
    let sun = 0, earth = 0;
    for (let j = start; j < end; j++) { sun += vs.sun[j]; earth += vs.ear[j]; }
    const dayStats = statsFor(d, s0 + start, count);
    const v = verdict(d, aim, dayStats, p);
    out.push({ date_utc: nativeTime(d, s0 + start).slice(0, 10), start_utc: nativeTime(d, s0 + start), end_utc: nativeTime(d, s0 + end - 1),
      sun_visible_pct: round(100 * sun / count, 2), earth_visible_pct: round(100 * earth / count, 2), sun_visible_minutes: sun * step,
      earth_visible_minutes: earth * step, pass: v.pass, failed_conditions: v.reasons.filter((r: any) => !r.ok).map((r: any) => r.label),
      aim_sun_pct: round(dayStats.sun[aim], 2), aim_earth_pct: round(dayStats.earth[aim], 2), aim_sun_gap_h: round(dayStats.sunGap[aim], 2), aim_earth_gap_h: round(dayStats.earthGap[aim], 2) });
  }
  return out;
}
function skyJson(d: SiteData, aim: number, s0: number, n: number): AnyRecord {
  const sun: AnyRecord[] = [], earth: AnyRecord[] = [], horizon: AnyRecord[] = [];
  for (let j = 0; j < n; j++) {
    const t = nativeTime(d, s0 + j), e = eph(d, s0 + j);
    sun.push({ utc: t, azimuth_deg: jsonNumber(e.sa), elevation_deg: jsonNumber(e.se) });
    earth.push({ utc: t, azimuth_deg: jsonNumber(e.ea), elevation_deg: jsonNumber(e.ee) });
  }
  for (let azimuth = 0; azimuth <= 360; azimuth++) horizon.push({ azimuth_deg: azimuth, elevation_deg: hzAt(d, aim, azimuth % 360) });
  return { sun, earth, horizon };
}
function failedWhy(d: SiteData, aim: number, s0: number, n: number, vs: any, p: Profile, st: any): AnyRecord {
  const v = verdict(d, aim, st, p), step = d.M.ephem.step_min;
  const failedDays = dailySeries(d, aim, s0, n, vs, p, st).filter((x) => !x.pass).map((x) => ({ date_utc: x.date_utc, failed_conditions: x.failed_conditions }));
  const blocking_ranges: AnyRecord[] = [];
  for (const [body, arr, ai] of [['sun', vs.sun, 0], ['earth', vs.ear, 2] as any]) {
    for (const [a, b] of runs(new Uint8Array(Array.from(arr, (x: number) => x ? 0 : 1)))) {
      if (b <= a) continue;
      const before = eph(d, s0 + a), after = eph(d, s0 + Math.min(b - 1, n - 1));
      const az0 = (before as any)[ai], az1 = (after as any)[ai];
      blocking_ranges.push({ body, start_utc: nativeTime(d, s0 + a), end_utc: nativeTime(d, s0 + b), duration_minutes: (b - a) * step,
        azimuth_start_deg: jsonNumber(az0), azimuth_end_deg: jsonNumber(az1),
        elevation_start_deg: jsonNumber((before as any)[ai + 1]), elevation_end_deg: jsonNumber((after as any)[ai + 1]),
        horizon_start_deg: jsonNumber(hzAt(d, aim, az0)), horizon_end_deg: jsonNumber(hzAt(d, aim, az1)),
        failed_at_aim: v.reasons.some((r: any) => !r.ok && ((body === 'sun' && r.label === 'Sunlight') || (body === 'earth' && r.label === 'Earth visibility'))) });
    }
  }
  return { failed_days: failedDays, blocking_ranges };
}
function countdowns(d: SiteData, aim: number, s0: number, n: number, vs: any): AnyRecord {
  const item = (which: 'sun' | 'earth', label: string) => {
    const c = (requireNextChange as any)(d, aim, which, vs, 0, s0, n);
    if (!c) return { site_name: d.entry.name, from_utc: nativeTime(d, s0), label, next_change_utc: null, seconds_from_window_start: null, to_visible: null };
    return { site_name: d.entry.name, from_utc: nativeTime(d, s0), label, next_change_utc: new Date(d.T0 + s0 * d.STEP_MS + c.ms).toISOString(), seconds_from_window_start: c.ms / 1000, to_visible: !!c.to, native: { ms: c.ms, to: c.to } };
  };
  return { sun: item('sun', 'Sun visibility change'), earth: item('earth', 'Earth visibility change') };
}
// Kept as an indirection because the imported function is named nextChange in the native module.
import { nextChange as nativeNextChange } from '../frontend/src/app/core/engine';
const requireNextChange = nativeNextChange;

function baselineBody(e: AnyRecord, arrivalDelayDays = 0, aimOverride?: number): AnyRecord {
  const d = e._site as SiteData, s0 = e._s0 as number, n = e._n as number, aim = aimOverride ?? e.aim_index;
  const p = bodyProfile(e), st = statsFor(d, s0, n), pg = passFor(d, st, p), v = verdict(d, aim, st, p), vs = visSeries(d, aim, s0, n);
  const b = bestAim(d, e.drift_m, pg, aim), [lat, lon] = spotLatlon(d, aim);
  return {
    site: { id: d.entry.id, name: d.M.site.name, source: d.entry.source, aim_latlon_deg: [round(lat, 5), round(lon, 5)], aim_is_default: aim === d.defaultAim, aim: aimPoint(d, aim) },
    window: { landing_utc: nativeTime(d, s0), duration_days: e.duration_days, sampling_min: d.M.ephem.step_min, time_system: 'UTC' },
    mission_profile: { ...p }, drift_radius_m: e.drift_m, arrival_shift_h: arrivalDelayDays * 24,
    results_at_aim: { verdict: v.pass ? 'PASS' : 'FAIL', conditions: conditions(d, st, aim, p), reasons_failed: v.reasons.filter((r: any) => !r.ok).map(reasonText),
      sun_visible_pct: round(st.sun[aim], 2), earth_visible_pct: round(st.earth[aim], 2), sun_windows: windowJson(d, vs.sun, s0), earth_windows: windowJson(d, vs.ear, s0) },
    dispersion: dispersionJson(d, pg, aim, e.drift_m),
    assumptions: d.M.assumptions, sources: d.M.sources,
    metadata: { terrain_res_m: d.M.hillshade.res, spot_spacing_m: d.M.spots.spacing_m, horizon: d.M.horizon, ephemeris: { source: d.M.ephem.source, start_utc: d.M.ephem.start_utc, step_min: d.M.ephem.step_min } },
    daily_series: dailySeries(d, aim, s0, n, vs, p, st), sky: skyJson(d, aim, s0, n), why: failedWhy(d, aim, s0, n, vs, p, st),
    countdowns: countdowns(d, aim, s0, n, vs), validation_vs_jpl_horizons: d.M.validation_vs_jpl_horizons,
  };
}
function shiftedEffective(e: AnyRecord, s1: number, aim: number): AnyRecord {
  const x = { ...e, start_date: nativeTime(e._site, s1), aim_index: aim, _s0: s1 };
  return x;
}
function offsetAim(d: SiteData, current: number, offset: AnyRecord): { aim: number; offset: [number, number] } {
  if (!offset || typeof offset !== 'object' || !finite(offset.x) || !finite(offset.y)) fail('landing_shift_m must be an object with finite x and y metre offsets');
  const currentSpot = spot(d, current), tx = currentSpot.x + offset.x, ty = currentSpot.y + offset.y;
  let best = -1, dist = Infinity;
  for (let k = 0; k < d.N; k++) { const q = spot(d, k), dd = Math.hypot(q.x - tx, q.y - ty); if (dd < dist) { dist = dd; best = k; } }
  return { aim: best, offset: [offset.x, offset.y] };
}
function getBaseline(args: AnyRecord, context?: AnyRecord): AnyRecord {
  const assumed: string[] = [], site = siteOf(args.site ?? context?.site), e = effectiveFor(args, context, 'get_baseline', site, assumed);
  const baseline = baselineBody(e);
  return wrapper('get_baseline', e, assumed, { baseline, daily_series: baseline.daily_series, sky: baseline.sky, why: baseline.why, countdowns: baseline.countdowns });
}
function runScenario(args: AnyRecord, context?: AnyRecord): AnyRecord {
  const assumed: string[] = [], site = siteOf(args.site ?? context?.site), e = effectiveFor(args, context, 'run_scenario', site, assumed);
  const baseline = baselineBody({ ...e, arrival_delay_days: 0 }, 0);
  const delaySteps = Math.round((e.arrival_delay_days * 864e5) / site.STEP_MS);
  let shiftedAim = e.aim_index, landing_shift: AnyRecord | null = null;
  if (args.landing_shift_m !== undefined) { const x = offsetAim(site, e.aim_index, args.landing_shift_m); shiftedAim = x.aim; landing_shift = { offset_m: x.offset, requested_aim_index: e.aim_index, shifted_aim_index: x.aim, actual_shift_m: [spot(site, x.aim).x - spot(site, e.aim_index).x, spot(site, x.aim).y - spot(site, e.aim_index).y] }; }
  if (e.arrival_delay_days > 0) {
    const shift = arrivalShift(site, e._s0, e._n, e.aim_index, e.drift_m, e.profile, e.arrival_delay_days * 24, statsFor(site, e._s0, e._n), passFor(site, statsFor(site, e._s0, e._n), e.profile));
    if (!shift.ok) fail(shift.msg);
  }
  const s1 = e._s0 + delaySteps;
  if (s1 + e._n > site.M.ephem.n) fail('arrival_delay_days moves the scenario outside native ephemeris coverage');
  const se = shiftedEffective(e, s1, shiftedAim);
  const shifted = baselineBody(se, e.arrival_delay_days, shiftedAim);
  const bres = baseline.results_at_aim, sres = shifted.results_at_aim;
  const delta = (a: any, b: any) => ({ sun_visible_pct: round(b.sun_visible_pct - a.sun_visible_pct, 6), earth_visible_pct: round(b.earth_visible_pct - a.earth_visible_pct, 6), sun_gap_h: round((b.conditions.find((x: any) => x.condition === 'Longest dark period')?.value ?? NaN) - (a.conditions.find((x: any) => x.condition === 'Longest dark period')?.value ?? NaN), 6), earth_gap_h: round((b.conditions.find((x: any) => x.condition === 'Longest Earth outage')?.value ?? NaN) - (a.conditions.find((x: any) => x.condition === 'Longest Earth outage')?.value ?? NaN), 6), pass_changed: a.verdict !== b.verdict });
  return wrapper('run_scenario', e, assumed, { baseline, shifted, deltas: delta(bres, sres), landing_shift });
}
function rowFor(d: SiteData, start: Date, duration: number, p: Profile, drift: number, aimInput?: any): CmpRow {
  const n = Math.round((duration * 864e5) / d.STEP_MS) + 1, s0 = Math.round((start.getTime() - d.T0) / d.STEP_MS), aim = aimInput === undefined ? d.defaultAim : aimInput;
  if (!Number.isInteger(aim) || aim < 0 || aim >= d.N) fail(`aim_index for ${d.entry.name} must be between 0 and ${d.N - 1}`);
  if (s0 < 0 || s0 + n > d.M.ephem.n) fail(`date and duration do not fit native coverage for ${d.entry.name}`);
  return { key: d.entry.id, name: d.entry.name, label: d.entry.name, short: d.entry.name.slice(0, 15), title: d.entry.name, d, aim, s0, n, ok: true };
}
function publicCmpRow(w: any, duration: number, p: Profile, drift: number): AnyRecord {
  const v = w.v, st = w.st;
  return { site: { id: w.d.entry.id, name: w.d.entry.name }, start_date: nativeTime(w.d, w.s0), duration_days: duration,
    sun_pct: round(st.sun[w.aim], 2), earth_pct: round(st.earth[w.aim], 2), sun_gap_h: round(st.sunGap[w.aim], 2), earth_gap_h: round(st.earthGap[w.aim], 2), acceptable_pct: finite(w.share) ? round(100 * w.share, 2) : null,
    best_acceptable_pct: finite(w.best) ? round(100 * w.best, 2) : null, pass: !!v.pass, conditions: conditions(w.d, st, w.aim, p), effective: { site: w.d.entry.id, site_name: w.d.entry.name, start_date: nativeTime(w.d, w.s0), duration_days: duration, drift_m: drift, arrival_delay_days: 0, aim_index: w.aim, profile: p } };
}
function compareTool(args: AnyRecord, context?: AnyRecord): AnyRecord {
  if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 8) fail('items must contain between 1 and 8 site/date entries');
  const assumed: string[] = [], first = args.items[0], firstSite = siteOf(first?.site), base = effectiveFor({ ...args, site: first?.site, start_date: first?.start_date, duration_days: args.duration_days ?? args.durationDays }, context, 'compare', firstSite, assumed);
  const p = base.profile, rows = args.items.map((item: any) => { if (!item || typeof item !== 'object') fail('each compare item must be an object'); const d = siteOf(item.site); const sameSite = context?.site && siteOf(context.site).entry.id === d.entry.id; return rowFor(d, dateValue(item.start_date ?? item.startDate, 'items[].start_date'), base.duration_days, p, base.drift_m, item.aim_index ?? item.aimIndex ?? (sameSite ? context?.aimIndex : undefined)); });
  const result = nativeCompare(rows, base.drift_m, p, 'site/date');
  const publicRows = result.rows.map((r: any) => publicCmpRow(r, base.duration_days, p, base.drift_m));
  const bestIndex = result.best ? result.rows.indexOf(result.best) : null;
  const flip = result.flip ? { r: result.flip.r, from: { site: { id: result.flip.from.d.entry.id, name: result.flip.from.d.entry.name }, index: result.rows.indexOf(result.flip.from) }, to: { site: { id: result.flip.to.d.entry.id, name: result.flip.to.d.entry.name }, index: result.rows.indexOf(result.flip.to) } } : null;
  const timeline = Array.from({ length: base._n }, (_, i) => ({ sample: i, offset_minutes: i * firstSite.M.ephem.step_min, relative_utc: nativeTime(firstSite, base._s0 + i) }));
  return wrapper('compare', base, assumed, { rows: publicRows, shared_timeline: timeline, best: bestIndex === null ? null : { index: bestIndex, ...publicRows[bestIndex] }, flip, native_summary: result.text });
}
function findAlternatives(args: AnyRecord, context?: AnyRecord): AnyRecord {
  const assumed: string[] = [], site = siteOf(args.site ?? context?.site), max = integerArg(args, ['max_delay_days', 'maxDelayDays'], 14, 'max_delay_days');
  if (max.value < 0 || max.value > 60) fail('max_delay_days must be between 0 and 60');
  const minSun = args.min_sun_pct ?? args.minSunPct, minEarth = args.min_earth_pct ?? args.minEarthPct;
  const patchedProfile = { ...(args.profile ?? context?.profile ?? DEFAULT_PROFILE), ...(minSun === undefined ? {} : { minSun }), ...(minEarth === undefined ? {} : { minEarth }) };
  const common = { ...args, site: site.entry.id, profile: patchedProfile }, e = effectiveFor(common, context, 'find_alternatives', site, assumed);
  const top = integerArg(args, ['top_n', 'topN'], 5, 'top_n'); if (top.value < 1 || top.value > 5) fail('top_n must be between 1 and 5');
  const dateRows: CmpRow[] = [];
  const availableDays = Math.max(0, Math.floor((site.M.ephem.n - e._n - e._s0) * site.STEP_MS / 864e5));
  const scannedDays = Math.min(max.value, availableDays);
  for (let i = 1; i <= scannedDays; i++) dateRows.push(rowFor(site, new Date(e._s0 * site.STEP_MS + site.T0 + i * 864e5), e.duration_days, e.profile, e.drift_m, e.aim_index));
  const siteRows: CmpRow[] = SITES.filter((d) => d.entry.id !== site.entry.id).filter(d => { const s0 = Math.round((Date.parse(e.start_date)-d.T0)/d.STEP_MS), n = Math.round(e.duration_days*864e5/d.STEP_MS)+1; return s0 >= 0 && s0+n <= d.M.ephem.n; }).map((d) => rowFor(d, new Date(e.start_date), e.duration_days, e.profile, e.drift_m));
  const dateCmp = nativeCompare(dateRows, e.drift_m, e.profile, 'date'), siteCmp = nativeCompare(siteRows, e.drift_m, e.profile, 'site');
  const score = (w: any) => [finite(w.share) ? w.share : -1, w.v?.pass ? 1 : 0, finite(w.st?.sun[w.aim]) ? w.st.sun[w.aim] : -1];
  const better = (a: any, b: any) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
  const sortRows = (rows: any[]) => [...rows].sort(better).slice(0, top.value).map((r) => { const out = publicCmpRow(r, e.duration_days, e.profile, e.drift_m); const baselineSt = statsFor(site, e._s0, e._n); return { ...out, delta_sun_pct: round((out.sun_pct ?? NaN) - baselineSt.sun[e.aim_index], 2), delta_earth_pct: round((out.earth_pct ?? NaN) - baselineSt.earth[e.aim_index], 2) }; });
  return wrapper('find_alternatives', e, assumed, { baseline: baselineBody(e), alternative_dates: sortRows(dateCmp.rows), alternative_sites: sortRows(siteCmp.rows), search: { requested_delay_days: max.value, same_site_days: scannedDays, coverage_limited: scannedDays < max.value, same_date_sites: siteRows.length, top_n: top.value, min_sun_pct: e.profile.minSun, min_earth_pct: e.profile.minEarth } });
}
function dispersionTool(args: AnyRecord, context?: AnyRecord): AnyRecord {
  const assumed: string[] = [], site = siteOf(args.site ?? context?.site), e = effectiveFor(args, context, 'dispersion', site, assumed), st = statsFor(site, e._s0, e._n), pg = passFor(site, st, e.profile);
  const d = dispersionJson(site, pg, e.aim_index, e.drift_m);
  return wrapper('dispersion', e, assumed, { dispersion: d, curve: d.curve, flip: d.flip });
}
function dispatch(tool: string, args: AnyRecord, context?: AnyRecord): AnyRecord {
  if (!VALID_TOOLS.has(tool)) fail(`Unknown tool '${tool}'. Valid tools: ${Array.from(VALID_TOOLS).join(', ')}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('tool args must be an object');
  if (tool === 'list_sites') return { tool, effective: {}, defaults_assumed: [], sites: SITES.map((d) => ({ id: d.entry.id, name: d.entry.name, coverage_start_utc: nativeTime(d, 0), coverage_end_utc: nativeTime(d, d.M.ephem.n - 1), description: d.entry.description, source: d.entry.source })), defaults: { duration_days: 10, drift_m: 100, profile: { ...DEFAULT_PROFILE }, date: 'first_covered_date' }, glossary: Object.values(GLOSSARY) };
  if (tool === 'get_baseline') return getBaseline(args, context);
  if (tool === 'run_scenario') return runScenario(args, context);
  if (tool === 'compare') return compareTool(args, context);
  if (tool === 'find_alternatives') return findAlternatives(args, context);
  return dispersionTool(args, context);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let request: any;
  try {
    request = JSON.parse(line);
    const result = dispatch(String(request.tool ?? ''), request.args ?? {}, request.context);
    process.stdout.write(JSON.stringify({ id: request.id ?? null, result: publicValue(result) }) + '\n');
  } catch (error: any) {
    const message = String(error?.message ?? error).replace(/[\r\n].*$/s, '').replace(/\b(?:\/[^ ]+|[A-Za-z]:\\[^ ]+)\b/g, '[path]').slice(0, 500);
    process.stdout.write(JSON.stringify({ id: request?.id ?? null, error: message || 'Engine request failed' }) + '\n');
  }
});
