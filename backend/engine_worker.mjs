// backend/engine_worker.ts
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as readline from "node:readline";

// frontend/src/app/core/engine.ts
var WEAK_GAP_M = 20;
var R_MOON = 1737400;
var fmt = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d) : "\u2013";
var iso = (t) => t.toISOString().slice(0, 16).replace("T", " ") + " UTC";
var hzAt = (d, k, az) => {
  const i = Math.floor(az) % 360, f = az - Math.floor(az), b = k * 360;
  return (d.HZ[b + i] * (1 - f) + d.HZ[b + (i + 1) % 360] * f) / 100;
};
var eph = (d, j) => {
  const b = 4 * j;
  return { sa: d.EPH[b], se: d.EPH[b + 1], ea: d.EPH[b + 2], ee: d.EPH[b + 3] };
};
var spot = (d, k) => {
  const b = 5 * k;
  return { x: d.SP[b], y: d.SP[b + 1], slope: d.SP[b + 2], toterr: d.SP[b + 3], gap: d.SP[b + 4] };
};
var idxTime = (d, j) => new Date(d.T0 + j * d.STEP_MS);
function computeStats(d, s0, n) {
  const { EPH, HZ, N } = d;
  const sunI = new Uint16Array(n), sunF = new Float32Array(n), earI = new Uint16Array(n), earF = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const e = eph(d, s0 + j);
    sunI[j] = Math.floor(e.sa) % 360;
    sunF[j] = e.sa - Math.floor(e.sa);
    earI[j] = Math.floor(e.ea) % 360;
    earF[j] = e.ea - Math.floor(e.ea);
  }
  const out = { sun: new Float32Array(N), earth: new Float32Array(N), sunGap: new Float32Array(N), earthGap: new Float32Array(N) };
  const h = d.STEP_MS / 36e5;
  for (let k = 0; k < N; k++) {
    const b = k * 360;
    let ns = 0, ne = 0, rs = 0, re = 0, gs = 0, ge = 0;
    for (let j = 0; j < n; j++) {
      const b4 = 4 * (s0 + j);
      const i = sunI[j], f = sunF[j];
      const hs = (HZ[b + i] * (1 - f) + HZ[b + (i + 1) % 360] * f) / 100;
      if (EPH[b4 + 1] > hs) {
        ns++;
        rs = 0;
      } else if (++rs > gs) gs = rs;
      const i2 = earI[j], f2 = earF[j];
      const he = (HZ[b + i2] * (1 - f2) + HZ[b + (i2 + 1) % 360] * f2) / 100;
      if (EPH[b4 + 3] > he) {
        ne++;
        re = 0;
      } else if (++re > ge) ge = re;
    }
    out.sun[k] = 100 * ns / n;
    out.earth[k] = 100 * ne / n;
    out.sunGap[k] = gs * h;
    out.earthGap[k] = ge * h;
  }
  return out;
}
function statsFor(d, s0, n) {
  const key = `${s0}:${n}`, c = d.cache;
  if (!c.has(key)) {
    if (c.size > 12) c.clear();
    c.set(key, computeStats(d, s0, n));
  }
  return c.get(key);
}
function verdict(d, k, st, p) {
  const s = spot(d, k), r = [];
  const add = (ok, label, value, dir, needNum, unit, dd = 1) => r.push({ ok, label, value, dir, needNum, need: `${dir} ${needNum}`, unit, d: dd });
  add(st.sun[k] >= p.minSun, "Sunlight", st.sun[k], "\u2265", p.minSun, "%");
  add(st.earth[k] >= p.minEarth, "Earth visibility", st.earth[k], "\u2265", p.minEarth, "%");
  add(st.sunGap[k] <= p.maxSunGap, "Longest dark period", st.sunGap[k], "\u2264", p.maxSunGap, "h");
  add(st.earthGap[k] <= p.maxEarthGap, "Longest Earth outage", st.earthGap[k], "\u2264", p.maxEarthGap, "h");
  add(s.slope <= p.maxSlope, "Slope", s.slope, "\u2264", p.maxSlope, "\xB0");
  const weak = s.gap > WEAK_GAP_M;
  r.push({ ok: !(weak && p.conservative), warn: weak, label: "Terrain data", value: s.gap, dir: "\u2264", needNum: WEAK_GAP_M, need: `nearest laser shot \u2264 ${WEAK_GAP_M} m`, unit: "m", d: 0 });
  return { pass: r.every((x) => x.ok), reasons: r, weak };
}
var margin = (r) => r.dir === "\u2265" ? r.value - r.needNum : r.needNum - r.value;
function reasonText(r) {
  if (r.label === "Terrain data") return `the nearest real laser measurement is ${fmt(r.value, 0)} m away (limit ${WEAK_GAP_M} m), so heights here are interpolated`;
  return `${r.label.toLowerCase()} is ${fmt(r.value, r.d)} ${r.unit}, required ${r.need} ${r.unit} (${r.dir === "\u2265" ? "short" : "over"} by ${fmt(Math.abs(margin(r)), r.d)} ${r.unit})`;
}
function passFor(d, st, p) {
  const g = new Uint8Array(d.N);
  for (let k = 0; k < d.N; k++) g[k] = verdict(d, k, st, p).pass ? 1 : 0;
  return g;
}
function diskOffsets(d, r) {
  const sp = d.M.spots.spacing_m, n = Math.floor(r / sp), out = [];
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx * dx + dy * dy) * sp * sp <= r * r) out.push([dx, dy]);
  return out;
}
function share(d, a, offs, pg) {
  const C = d.COLS, ac = a % C, ar = Math.floor(a / C);
  let ok = 0, tot = 0;
  for (const [dx, dy] of offs) {
    const c = ac + dx, rr = ar + dy;
    if (c < 0 || rr < 0 || c >= C || rr >= C) return NaN;
    tot++;
    ok += pg[rr * C + c];
  }
  return tot ? ok / tot : NaN;
}
function bestAim(d, r, pg, aim) {
  const offs = diskOffsets(d, r);
  let best = -1, bk = -1;
  const nominal = share(d, aim, offs, pg);
  for (let k = 0; k < d.N; k++) {
    const v = share(d, k, offs, pg);
    if (v > best + 1e-9) {
      best = v;
      bk = k;
    }
  }
  return { k: bk, share: best, nominal };
}
function dispersionCurve(d, pg, aim) {
  const out = [];
  for (let r = 0; r <= 500; r += 25) {
    const b = bestAim(d, r, pg, aim);
    out.push({ r, best: b.share, nominal: b.nominal, k: b.k });
  }
  return out;
}
function flipPoint(d, curve) {
  const ref = curve[1]?.k ?? -1;
  if (ref < 0) return null;
  return curve.find((c) => c.r > 25 && c.k !== ref && Math.hypot(spot(d, c.k).x - spot(d, ref).x, spot(d, c.k).y - spot(d, ref).y) > 2 * d.M.spots.spacing_m) ?? null;
}
function visSeries(d, k, s0, n) {
  const sun = new Uint8Array(n), ear = new Uint8Array(n);
  for (let j = 0; j < n; j++) {
    const e = eph(d, s0 + j);
    sun[j] = e.se > hzAt(d, k, e.sa) ? 1 : 0;
    ear[j] = e.ee > hzAt(d, k, e.ea) ? 1 : 0;
  }
  return { sun, ear };
}
function runs(arr) {
  const out = [];
  let s = -1;
  for (let j = 0; j <= arr.length; j++) {
    const v = j < arr.length && arr[j];
    if (v && s < 0) s = j;
    if (!v && s >= 0) {
      out.push([s, j]);
      s = -1;
    }
  }
  return out;
}
function nextChange(d, k, which, vs, cursor, s0, n) {
  const arr = which === "sun" ? vs.sun : vs.ear, ai = which === "sun" ? 0 : 2, ei = ai + 1, c = cursor;
  for (let j = c + 1; j < n; j++) if (arr[j] !== arr[c]) {
    const m = (i) => {
      const b = 4 * (s0 + i);
      return d.EPH[b + ei] - hzAt(d, k, d.EPH[b + ai]);
    };
    const m0 = m(j - 1), m1 = m(j), f = m0 === m1 ? 0 : m0 / (m0 - m1);
    return { ms: (j - 1 - c + Math.min(Math.max(f, 0), 1)) * d.STEP_MS, to: arr[j] };
  }
  return null;
}
function xyToLatlon(x, y) {
  const rho = Math.hypot(x, y);
  return [(2 * Math.atan(rho / (2 * R_MOON)) - Math.PI / 2) * 180 / Math.PI, Math.atan2(x, y) * 180 / Math.PI];
}
function spotLatlon(d, k) {
  const s = spot(d, k), [ax, ay] = d.M.site.aim_xy;
  return xyToLatlon(ax + s.x, ay + s.y);
}

// frontend/src/app/core/analysis.ts
var pct = (v) => v !== void 0 && Number.isFinite(v) ? `${fmt(100 * v, 0)}%` : "n/a";
function compare(rows, drift, p, noun) {
  for (const w of rows) if (w.ok) {
    const d = w.d, offs = diskOffsets(d, drift);
    w.st = statsFor(d, w.s0, w.n);
    w.pg = passFor(d, w.st, p);
    w.v = verdict(d, w.aim, w.st, p);
    w.share = share(d, w.aim, offs, w.pg);
    w.best = bestAim(d, drift, w.pg, w.aim).share;
    w.vis = visSeries(d, w.aim, w.s0, w.n);
  }
  const valid = rows.filter((w) => w.ok);
  const score = (w) => [w.share, w.v.pass ? 1 : 0, w.st.sun[w.aim]];
  const better = (x, y) => {
    const a = score(x), b = score(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };
  let best = null;
  for (const w of valid) if (!best || better(w, best)) best = w;
  if (best && !(best.share > 0)) best = null;
  let flip = null;
  if (valid.length > 1) {
    const winner = (r) => {
      let bw = null, bv = -1;
      for (const w of valid) {
        const v = share(w.d, w.aim, diskOffsets(w.d, r), w.pg);
        if (v > bv + 1e-9) {
          bv = v;
          bw = w;
        }
      }
      return bv > 0 ? bw : null;
    };
    const ref = winner(25);
    for (let r = 50; r <= 500 && ref; r += 25) {
      const w = winner(r);
      if (w && w !== ref) {
        flip = { r, from: ref, to: w };
        break;
      }
    }
  }
  const others = valid.filter((w) => w !== best);
  let text;
  if (!valid.length) text = `Pick at least one ${noun} inside the data range.`;
  else if (!best) text = `No ${noun} in this comparison works: within ${drift} m of the aim point, no landing spot meets the mission profile for any of them.`;
  else {
    text = `Best: ${best.label}. Within ${drift} m of the aim point, ${pct(best.share)} of the possible analyzed spots under a uniform circular drift meet the profile` + (others.length ? `, against ${others.map((w) => `${pct(w.share)} for ${w.label}`).join(" and ")}. ` : ". ") + `At the aim point itself: sunlight ${fmt(best.st.sun[best.aim])}%, longest dark period ${fmt(best.st.sunGap[best.aim])} h. `;
    for (const w of others.filter((x) => !x.v.pass))
      text += `${w.label} fails at its aim point because ${w.v.reasons.filter((x) => !x.ok).map(reasonText).join("; ")}. `;
  }
  text += flip ? ` First decision crossover: at ${flip.r} m drift, ${flip.to.label} becomes better than ${flip.from.label}.` : valid.length > 1 && best ? ` The best ${noun} does not change between 25 m and 500 m of drift.` : "";
  return { rows, best, flip, text };
}
function arrivalShift(d, s0, n, aim, drift, p, h, baseStats, basePass) {
  const totMin = n * d.M.ephem.step_min;
  if (!h) return { ok: false, h, totMin, msg: "Set an arrival-time shift (for example +48 h) to see how a launch delay changes feasibility at your aim point." };
  const s1 = s0 + Math.round(h * 60 / d.M.ephem.step_min);
  if (s1 + n > d.M.ephem.n) return { ok: false, h, totMin, msg: `Out of range: a ${h} h shift ends after the precomputed data (${iso(idxTime(d, d.M.ephem.n - 1)).slice(0, 10)}). Pick an earlier landing time or a smaller shift.` };
  const offs = diskOffsets(d, drift), stS = statsFor(d, s1, n), pgS = passFor(d, stS, p);
  const pick = (t, st, pg) => ({ t, sun: st.sun[aim], earth: st.earth[aim], sunGap: st.sunGap[aim], earthGap: st.earthGap[aim], v: verdict(d, aim, st, p), share: share(d, aim, offs, pg) });
  const B = pick(idxTime(d, s0), baseStats, basePass), S = pick(idxTime(d, s1), stS, pgS);
  const sgn = (x, dd = 1) => `${x > 0 ? "+" : x < 0 ? "\u2212" : "\xB1"}${fmt(Math.abs(x), dd)}`;
  let msg = `Arrival-time shift of +${h} h: sunlight at the aim point goes from ${fmt(B.sun)}% to ${fmt(S.sun)}% (${sgn((S.sun - B.sun) / 100 * totMin, 0)} min), Earth visibility from ${fmt(B.earth)}% to ${fmt(S.earth)}% (${sgn((S.earth - B.earth) / 100 * totMin, 0)} min), and the longest dark period from ${fmt(B.sunGap)} h to ${fmt(S.sunGap)} h. `;
  if (B.v.pass && !S.v.pass) msg += `The aim point stops meeting the profile because ${S.v.reasons.filter((r) => !r.ok).map(reasonText).join("; ")}. `;
  else if (!B.v.pass && S.v.pass) msg += "With the delay, the aim point now meets every condition of the profile. ";
  else msg += `The verdict at the aim point stays ${S.v.pass ? "PASS" : "FAIL"}. `;
  if (Number.isFinite(B.share) && Number.isFinite(S.share)) msg += `Within ${drift} m of the aim, acceptable analyzed spots under a uniform circular drift go from ${pct(B.share)} to ${pct(S.share)}.`;
  return { ok: true, h, totMin, msg, base: B, shifted: S };
}

// backend/engine_worker.ts
var HERE = dirname(fileURLToPath(import.meta.url));
var DEFAULT_DATA_DIRS = [
  process.env.SHOTSPOT_DATA_DIR,
  resolve(HERE, "../web/data"),
  resolve(HERE, "../ready-to-run/data"),
  resolve(HERE, "../frontend/dist/frontend/browser/data")
].filter(Boolean);
var DEFAULT_PROFILE = {
  minSun: 40,
  minEarth: 50,
  maxSunGap: 72,
  maxEarthGap: 48,
  maxSlope: 8,
  conservative: false
};
var VALID_TOOLS = /* @__PURE__ */ new Set(["list_sites", "get_baseline", "compare", "run_scenario", "find_alternatives", "dispersion"]);
var GLOSSARY = {
  elevation: { term: "elevation", definition: "Angle above the local terrain horizon.", egyptian_arabic: "\u0632\u0627\u0648\u064A\u0629 \u0627\u0644\u062C\u0633\u0645 \u0641\u0648\u0642 \u0623\u0641\u0642 \u0627\u0644\u062A\u0636\u0627\u0631\u064A\u0633 \u0627\u0644\u0645\u062D\u0644\u064A." },
  azimuth: { term: "azimuth", definition: "Compass direction around the horizon, in degrees.", egyptian_arabic: "\u0627\u062A\u062C\u0627\u0647 \u0627\u0644\u062C\u0633\u0645 \u062D\u0648\u0627\u0644\u064A\u0646 \u0627\u0644\u0623\u0641\u0642 \u0628\u0627\u0644\u062F\u0631\u062C\u0627\u062A." },
  horizon: { term: "horizon", definition: "The terrain elevation that can block a body at a given azimuth.", egyptian_arabic: "\u0627\u0631\u062A\u0641\u0627\u0639 \u0627\u0644\u062A\u0636\u0627\u0631\u064A\u0633 \u0627\u0644\u0644\u064A \u0645\u0645\u0643\u0646 \u064A\u062D\u062C\u0628 \u0627\u0644\u062C\u0633\u0645 \u0641\u064A \u0627\u062A\u062C\u0627\u0647 \u0645\u0639\u064A\u0651\u0646." },
  sunset: { term: "sunset", definition: "The native engine transition from Sun visible to not visible.", egyptian_arabic: "\u0644\u062D\u0638\u0629 \u0627\u0646\u062A\u0642\u0627\u0644 \u0627\u0644\u0634\u0645\u0633 \u0645\u0646 \u0638\u0627\u0647\u0631\u0629 \u0644\u063A\u064A\u0631 \u0638\u0627\u0647\u0631\u0629 \u062D\u0633\u0628 \u0627\u0644\u0645\u062D\u0631\u0643." },
  earthset: { term: "Earthset", definition: "The native engine transition from Earth visible to not visible.", egyptian_arabic: "\u0644\u062D\u0638\u0629 \u0627\u0646\u062A\u0642\u0627\u0644 \u0627\u0644\u0623\u0631\u0636 \u0645\u0646 \u0638\u0627\u0647\u0631\u0629 \u0644\u063A\u064A\u0631 \u0638\u0627\u0647\u0631\u0629 \u062D\u0633\u0628 \u0627\u0644\u0645\u062D\u0631\u0643." },
  libration: { term: "libration", definition: "The apparent rocking that changes the geometry of the lunar view over time.", egyptian_arabic: "\u0627\u0644\u062A\u0645\u0627\u064A\u0644 \u0627\u0644\u0638\u0627\u0647\u0631\u064A \u0627\u0644\u0644\u064A \u0628\u064A\u063A\u064A\u0651\u0631 \u0647\u0646\u062F\u0633\u0629 \u0627\u0644\u0631\u0624\u064A\u0629 \u0645\u0646 \u0627\u0644\u0642\u0645\u0631 \u0645\u0639 \u0627\u0644\u0648\u0642\u062A." },
  drift: { term: "drift", definition: "A user-supplied circular landing-radius input, not a prediction.", egyptian_arabic: "\u0646\u0637\u0627\u0642 \u062F\u0627\u0626\u0631\u064A \u0628\u064A\u062F\u062E\u0644\u0647 \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645 \u0644\u0644\u0647\u0628\u0648\u0637\u060C \u0645\u0634 \u062A\u0646\u0628\u0624." }
};
function dataDir() {
  for (const candidate of DEFAULT_DATA_DIRS) {
    try {
      if (candidate && readFileSync(join(candidate, "sites.json"), "utf8")) return candidate;
    } catch {
    }
  }
  throw new Error("Native engine data could not be found");
}
function readTyped(path, kind) {
  const bytes = readFileSync(path);
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return kind === "float" ? new Float32Array(raw) : new Int16Array(raw);
}
function loadAllNative(base) {
  const list = JSON.parse(readFileSync(join(base, "sites.json"), "utf8"));
  return list.map((entry) => {
    const dir = join(base, String(entry.dir).replace(/^data\//, ""));
    const M = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    const EPH = readTyped(join(dir, "ephem.bin"), "float");
    const HZ = readTyped(join(dir, "horizon.bin"), "short");
    const SP = readTyped(join(dir, "spots.bin"), "float");
    const N = M.spots.n;
    const img = void 0;
    return {
      entry,
      M,
      EPH,
      HZ,
      SP,
      img,
      N,
      COLS: M.spots.cols,
      STEP_MS: M.ephem.step_min * 6e4,
      T0: Date.parse(M.ephem.start_utc),
      defaultAim: (N - 1) / 2,
      cache: /* @__PURE__ */ new Map()
    };
  });
}
var SITES = loadAllNative(dataDir());
var SITE_NAMES = SITES.map((d) => d.entry.name);
var byId = new Map(SITES.map((d) => [d.entry.id.toLowerCase(), d]));
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function iso2(d) {
  return d.toISOString();
}
function jsonNumber(value) {
  return typeof value === "number" && !Number.isFinite(value) ? null : value;
}
function publicValue(value) {
  if (typeof value === "number") return jsonNumber(value);
  if (value instanceof Date) return value.toISOString();
  if (ArrayBuffer.isView(value)) return Array.from(value, (v) => jsonNumber(v));
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = publicValue(child);
    return out;
  }
  return value;
}
function fail(message) {
  throw new Error(message.replace(/[\r\n].*$/s, "").slice(0, 500));
}
function norm(value) {
  return String(value ?? "").normalize("NFKD").toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = old;
    }
  }
  return row[b.length];
}
function siteOf(value) {
  if (typeof value !== "string" || !value.trim()) fail(`site is required; valid names: ${SITE_NAMES.join(", ")}`);
  const key = norm(value);
  const direct = byId.get(key);
  if (direct) return direct;
  const exact = SITES.find((d) => norm(d.entry.name) === key);
  if (exact) return exact;
  const contained = SITES.filter((d) => norm(d.entry.name).includes(key) || key.includes(norm(d.entry.name)));
  if (contained.length === 1) return contained[0];
  const ranked = SITES.map((d) => ({ d, n: editDistance(key, norm(d.entry.name)) })).sort((a, b) => a.n - b.n);
  const limit = Math.max(2, Math.floor(key.replace(/ /g, "").length * 0.25));
  if (ranked[0] && ranked[0].n <= limit && (!ranked[1] || ranked[0].n < ranked[1].n)) return ranked[0].d;
  fail(`Unknown site '${String(value)}'. Valid site names: ${SITE_NAMES.join(", ")}`);
}
function dateValue(value, field = "start_date") {
  if (typeof value !== "string" || !value.trim()) fail(`${field} is required as an ISO UTC date`);
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : /Z$|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) fail(`${field} must be a valid ISO UTC date`);
  return new Date(t);
}
function numberArg(args, names, fallback, label) {
  let value;
  let usedDefault = false;
  for (const name of names) if (args[name] !== void 0) {
    value = args[name];
    break;
  }
  if (value === void 0) {
    if (fallback === void 0) fail(`${label} is required`);
    value = fallback;
    usedDefault = true;
  }
  if (!finite(value)) fail(`${label} must be a finite number`);
  return { value, usedDefault };
}
function integerArg(args, names, fallback, label) {
  const x = numberArg(args, names, fallback, label);
  if (!Number.isInteger(x.value)) fail(`${label} must be an integer`);
  return x;
}
function profileOf(args, context, assumed) {
  const supplied = args.profile ?? context?.profile;
  if (supplied === void 0) {
    assumed.push("profile");
    return { ...DEFAULT_PROFILE };
  }
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) fail("profile must be an object");
  const out = { ...DEFAULT_PROFILE, ...context?.profile ?? {}, ...supplied };
  for (const key of ["minSun", "minEarth"]) if (!finite(out[key]) || out[key] < 0 || out[key] > 100) fail(`profile.${key} must be between 0 and 100`);
  for (const key of ["maxSunGap", "maxEarthGap"]) if (!finite(out[key]) || out[key] < 0 || out[key] > 24 * 365) fail(`profile.${key} must be between 0 and 8760`);
  if (!finite(out.maxSlope) || out.maxSlope < 0 || out.maxSlope > 90) fail("profile.maxSlope must be between 0 and 90");
  if (typeof out.conservative !== "boolean") fail("profile.conservative must be boolean");
  return out;
}
function effectiveFor(args, context, tool, site, assumed) {
  const contextDuration = context?.durationDays ?? context?.duration_days;
  const duration = numberArg(args, ["duration_days", "durationDays"], contextDuration ?? 10, "duration_days");
  if (duration.usedDefault && contextDuration === void 0) assumed.push("duration_days=10");
  if (duration.value <= 0 || duration.value > 365) fail("duration_days must be greater than 0 and no more than 365");
  const startRaw = args.start_date ?? args.startDate ?? context?.date ?? context?.start_date;
  let start;
  if (startRaw === void 0) {
    start = new Date(site.T0);
    assumed.push("start_date=first_covered_date");
  } else start = dateValue(startRaw);
  const n = Math.round(duration.value * 864e5 / site.STEP_MS) + 1;
  const s0 = Math.round((start.getTime() - site.T0) / site.STEP_MS);
  if (!Number.isInteger(s0) || s0 < 0 || s0 + n > site.M.ephem.n) {
    const first = iso2(new Date(site.T0));
    const last = iso2(new Date(site.T0 + (site.M.ephem.n - n) * site.STEP_MS));
    fail(`start_date and duration_days must fit native coverage for ${site.entry.name}: ${first} to ${last}`);
  }
  const contextDrift = context?.driftM ?? context?.drift_m;
  const drift = numberArg(args, ["drift_m", "driftM"], contextDrift ?? 100, "drift_m");
  if (drift.usedDefault && contextDrift === void 0) assumed.push("drift_m=100");
  if (drift.value < 0 || drift.value > 500) fail("drift_m must be between 0 and 500 m");
  const delay = numberArg(args, ["arrival_delay_days", "arrivalDelayDays"], context?.arrivalDelayDays ?? 0, "arrival_delay_days");
  if (delay.value < 0 || delay.value > 365) fail("arrival_delay_days must be between 0 and 365 days");
  const p = profileOf(args, context, assumed);
  const contextIsSameSite = context?.site && siteOf(context.site).entry.id === site.entry.id;
  const aimInput = args.aim_index ?? args.aimIndex ?? (contextIsSameSite ? context?.aimIndex : void 0);
  const aim = aimInput === void 0 ? site.defaultAim : aimInput;
  if (!Number.isInteger(aim) || aim < 0 || aim >= site.N) fail(`aim_index must be an integer between 0 and ${site.N - 1}`);
  return {
    site: site.entry.id,
    site_name: site.entry.name,
    start_date: iso2(start),
    duration_days: duration.value,
    drift_m: drift.value,
    arrival_delay_days: delay.value,
    aim_index: aim,
    profile: p,
    _site: site,
    _s0: s0,
    _n: n
  };
}
function wrapper(tool, effective, defaults, body) {
  const cleanEffective = { ...effective };
  delete cleanEffective._site;
  delete cleanEffective._s0;
  delete cleanEffective._n;
  return publicValue({ tool, effective: cleanEffective, defaults_assumed: defaults, ...body });
}
function bodyProfile(e) {
  return e.profile;
}
function nativeTime(d, i) {
  return idxTime(d, i).toISOString();
}
function round(value, digits) {
  return finite(value) ? Number(value.toFixed(digits)) : null;
}
function conditions(d, st, aim, p) {
  const v = verdict(d, aim, st, p);
  const margin2 = (r) => r.dir === "\u2265" ? r.value - r.needNum : r.needNum - r.value;
  return v.reasons.map((r) => ({ condition: r.label, value: round(r.value, 3), required: r.need, unit: r.unit, margin: round(margin2(r), 3), ok: r.ok, warning: !!r.warn }));
}
function windowJson(d, arr, s0) {
  const stepMin = d.M.ephem.step_min;
  return runs(arr).map(([s, e]) => ({ start_utc: nativeTime(d, s0 + s), end_utc: nativeTime(d, s0 + e), minutes: (e - s) * stepMin }));
}
function aimPoint(d, k) {
  const [lat, lon] = spotLatlon(d, k);
  return { index: k, offset_m: [spot(d, k).x, spot(d, k).y], latlon_deg: [round(lat, 5), round(lon, 5)] };
}
function dispersionJson(d, pg, aim, drift) {
  const b = bestAim(d, drift, pg, aim), bs = b.k >= 0 ? spot(d, b.k) : null, current = spot(d, aim), curve = dispersionCurve(d, pg, aim), flip = flipPoint(d, curve);
  return {
    acceptable_at_aim_pct: finite(b.nominal) ? round(100 * b.nominal, 1) : null,
    acceptable_at_best_aim_pct: finite(b.share) ? round(100 * b.share, 1) : null,
    best_aim_offset_m: bs ? [bs.x, bs.y] : null,
    best_aim_offset_reference: "site grid origin",
    best_aim_relative_to_current_m: bs ? [bs.x - current.x, bs.y - current.y] : null,
    best_aim_movement_m: bs ? Math.hypot(bs.x - current.x, bs.y - current.y) : null,
    decision_flip_m: flip ? flip.r : null,
    decision_flip_description: "first sampled crossover; rankings may change again",
    nominal_share: jsonNumber(b.nominal),
    best_share: jsonNumber(b.share),
    best_aim_index: b.k,
    curve: curve.map((x) => ({ ...x, best_pct: finite(x.best) ? 100 * x.best : null, nominal_pct: finite(x.nominal) ? 100 * x.nominal : null })),
    flip: flip ? { ...flip, from_index: curve[1]?.k ?? null, to_index: flip.k } : null
  };
}
function dailySeries(d, aim, s0, n, vs, p, st) {
  const step = d.M.ephem.step_min;
  const perDay = Math.max(1, Math.round(1440 / step));
  const out = [];
  for (let start = 0; start < n; start += perDay) {
    const end = Math.min(n, start + perDay);
    const count = Math.max(1, end - start);
    let sun = 0, earth = 0;
    for (let j = start; j < end; j++) {
      sun += vs.sun[j];
      earth += vs.ear[j];
    }
    const dayStats = statsFor(d, s0 + start, count);
    const v = verdict(d, aim, dayStats, p);
    out.push({
      date_utc: nativeTime(d, s0 + start).slice(0, 10),
      start_utc: nativeTime(d, s0 + start),
      end_utc: nativeTime(d, s0 + end - 1),
      sun_visible_pct: round(100 * sun / count, 2),
      earth_visible_pct: round(100 * earth / count, 2),
      sun_visible_minutes: sun * step,
      earth_visible_minutes: earth * step,
      pass: v.pass,
      failed_conditions: v.reasons.filter((r) => !r.ok).map((r) => r.label),
      aim_sun_pct: round(dayStats.sun[aim], 2),
      aim_earth_pct: round(dayStats.earth[aim], 2),
      aim_sun_gap_h: round(dayStats.sunGap[aim], 2),
      aim_earth_gap_h: round(dayStats.earthGap[aim], 2)
    });
  }
  return out;
}
function skyJson(d, aim, s0, n) {
  const sun = [], earth = [], horizon = [];
  for (let j = 0; j < n; j++) {
    const t = nativeTime(d, s0 + j), e = eph(d, s0 + j);
    sun.push({ utc: t, azimuth_deg: jsonNumber(e.sa), elevation_deg: jsonNumber(e.se) });
    earth.push({ utc: t, azimuth_deg: jsonNumber(e.ea), elevation_deg: jsonNumber(e.ee) });
  }
  for (let azimuth = 0; azimuth <= 360; azimuth++) horizon.push({ azimuth_deg: azimuth, elevation_deg: hzAt(d, aim, azimuth % 360) });
  return { sun, earth, horizon };
}
function failedWhy(d, aim, s0, n, vs, p, st) {
  const v = verdict(d, aim, st, p), step = d.M.ephem.step_min;
  const failedDays = dailySeries(d, aim, s0, n, vs, p, st).filter((x) => !x.pass).map((x) => ({ date_utc: x.date_utc, failed_conditions: x.failed_conditions }));
  const blocking_ranges = [];
  for (const [body, arr, ai] of [["sun", vs.sun, 0], ["earth", vs.ear, 2]]) {
    for (const [a, b] of runs(new Uint8Array(Array.from(arr, (x) => x ? 0 : 1)))) {
      if (b <= a) continue;
      const before = eph(d, s0 + a), after = eph(d, s0 + Math.min(b - 1, n - 1));
      const az0 = before[ai], az1 = after[ai];
      blocking_ranges.push({
        body,
        start_utc: nativeTime(d, s0 + a),
        end_utc: nativeTime(d, s0 + b),
        duration_minutes: (b - a) * step,
        azimuth_start_deg: jsonNumber(az0),
        azimuth_end_deg: jsonNumber(az1),
        elevation_start_deg: jsonNumber(before[ai + 1]),
        elevation_end_deg: jsonNumber(after[ai + 1]),
        horizon_start_deg: jsonNumber(hzAt(d, aim, az0)),
        horizon_end_deg: jsonNumber(hzAt(d, aim, az1)),
        failed_at_aim: v.reasons.some((r) => !r.ok && (body === "sun" && r.label === "Sunlight" || body === "earth" && r.label === "Earth visibility"))
      });
    }
  }
  return { failed_days: failedDays, blocking_ranges };
}
function countdowns(d, aim, s0, n, vs) {
  const item = (which, label) => {
    const c = requireNextChange(d, aim, which, vs, 0, s0, n);
    if (!c) return { site_name: d.entry.name, from_utc: nativeTime(d, s0), label, next_change_utc: null, seconds_from_window_start: null, to_visible: null };
    return { site_name: d.entry.name, from_utc: nativeTime(d, s0), label, next_change_utc: new Date(d.T0 + s0 * d.STEP_MS + c.ms).toISOString(), seconds_from_window_start: c.ms / 1e3, to_visible: !!c.to, native: { ms: c.ms, to: c.to } };
  };
  return { sun: item("sun", "Sun visibility change"), earth: item("earth", "Earth visibility change") };
}
var requireNextChange = nextChange;
function baselineBody(e, arrivalDelayDays = 0, aimOverride) {
  const d = e._site, s0 = e._s0, n = e._n, aim = aimOverride ?? e.aim_index;
  const p = bodyProfile(e), st = statsFor(d, s0, n), pg = passFor(d, st, p), v = verdict(d, aim, st, p), vs = visSeries(d, aim, s0, n);
  const b = bestAim(d, e.drift_m, pg, aim), [lat, lon] = spotLatlon(d, aim);
  return {
    site: { id: d.entry.id, name: d.M.site.name, source: d.entry.source, aim_latlon_deg: [round(lat, 5), round(lon, 5)], aim_is_default: aim === d.defaultAim, aim: aimPoint(d, aim) },
    window: { landing_utc: nativeTime(d, s0), duration_days: e.duration_days, sampling_min: d.M.ephem.step_min, time_system: "UTC" },
    mission_profile: { ...p },
    drift_radius_m: e.drift_m,
    arrival_shift_h: arrivalDelayDays * 24,
    results_at_aim: {
      verdict: v.pass ? "PASS" : "FAIL",
      conditions: conditions(d, st, aim, p),
      reasons_failed: v.reasons.filter((r) => !r.ok).map(reasonText),
      sun_visible_pct: round(st.sun[aim], 2),
      earth_visible_pct: round(st.earth[aim], 2),
      sun_windows: windowJson(d, vs.sun, s0),
      earth_windows: windowJson(d, vs.ear, s0)
    },
    dispersion: dispersionJson(d, pg, aim, e.drift_m),
    assumptions: d.M.assumptions,
    sources: d.M.sources,
    metadata: { terrain_res_m: d.M.hillshade.res, spot_spacing_m: d.M.spots.spacing_m, horizon: d.M.horizon, ephemeris: { source: d.M.ephem.source, start_utc: d.M.ephem.start_utc, step_min: d.M.ephem.step_min } },
    daily_series: dailySeries(d, aim, s0, n, vs, p, st),
    sky: skyJson(d, aim, s0, n),
    why: failedWhy(d, aim, s0, n, vs, p, st),
    countdowns: countdowns(d, aim, s0, n, vs),
    validation_vs_jpl_horizons: d.M.validation_vs_jpl_horizons
  };
}
function shiftedEffective(e, s1, aim) {
  const x = { ...e, start_date: nativeTime(e._site, s1), aim_index: aim, _s0: s1 };
  return x;
}
function offsetAim(d, current, offset) {
  if (!offset || typeof offset !== "object" || !finite(offset.x) || !finite(offset.y)) fail("landing_shift_m must be an object with finite x and y metre offsets");
  const currentSpot = spot(d, current), tx = currentSpot.x + offset.x, ty = currentSpot.y + offset.y;
  let best = -1, dist = Infinity;
  for (let k = 0; k < d.N; k++) {
    const q = spot(d, k), dd = Math.hypot(q.x - tx, q.y - ty);
    if (dd < dist) {
      dist = dd;
      best = k;
    }
  }
  return { aim: best, offset: [offset.x, offset.y] };
}
function getBaseline(args, context) {
  const assumed = [], site = siteOf(args.site ?? context?.site), e = effectiveFor(args, context, "get_baseline", site, assumed);
  const baseline = baselineBody(e);
  return wrapper("get_baseline", e, assumed, { baseline, daily_series: baseline.daily_series, sky: baseline.sky, why: baseline.why, countdowns: baseline.countdowns });
}
function runScenario(args, context) {
  const assumed = [], site = siteOf(args.site ?? context?.site), e = effectiveFor(args, context, "run_scenario", site, assumed);
  const baseline = baselineBody({ ...e, arrival_delay_days: 0 }, 0);
  const delaySteps = Math.round(e.arrival_delay_days * 864e5 / site.STEP_MS);
  let shiftedAim = e.aim_index, landing_shift = null;
  if (args.landing_shift_m !== void 0) {
    const x = offsetAim(site, e.aim_index, args.landing_shift_m);
    shiftedAim = x.aim;
    landing_shift = { offset_m: x.offset, requested_aim_index: e.aim_index, shifted_aim_index: x.aim, actual_shift_m: [spot(site, x.aim).x - spot(site, e.aim_index).x, spot(site, x.aim).y - spot(site, e.aim_index).y] };
  }
  if (e.arrival_delay_days > 0) {
    const shift = arrivalShift(site, e._s0, e._n, e.aim_index, e.drift_m, e.profile, e.arrival_delay_days * 24, statsFor(site, e._s0, e._n), passFor(site, statsFor(site, e._s0, e._n), e.profile));
    if (!shift.ok) fail(shift.msg);
  }
  const s1 = e._s0 + delaySteps;
  if (s1 + e._n > site.M.ephem.n) fail("arrival_delay_days moves the scenario outside native ephemeris coverage");
  const se = shiftedEffective(e, s1, shiftedAim);
  const shifted = baselineBody(se, e.arrival_delay_days, shiftedAim);
  const bres = baseline.results_at_aim, sres = shifted.results_at_aim;
  const delta = (a, b) => ({ sun_visible_pct: round(b.sun_visible_pct - a.sun_visible_pct, 6), earth_visible_pct: round(b.earth_visible_pct - a.earth_visible_pct, 6), sun_gap_h: round((b.conditions.find((x) => x.condition === "Longest dark period")?.value ?? NaN) - (a.conditions.find((x) => x.condition === "Longest dark period")?.value ?? NaN), 6), earth_gap_h: round((b.conditions.find((x) => x.condition === "Longest Earth outage")?.value ?? NaN) - (a.conditions.find((x) => x.condition === "Longest Earth outage")?.value ?? NaN), 6), pass_changed: a.verdict !== b.verdict });
  return wrapper("run_scenario", e, assumed, { baseline, shifted, deltas: delta(bres, sres), landing_shift });
}
function rowFor(d, start, duration, p, drift, aimInput) {
  const n = Math.round(duration * 864e5 / d.STEP_MS) + 1, s0 = Math.round((start.getTime() - d.T0) / d.STEP_MS), aim = aimInput === void 0 ? d.defaultAim : aimInput;
  if (!Number.isInteger(aim) || aim < 0 || aim >= d.N) fail(`aim_index for ${d.entry.name} must be between 0 and ${d.N - 1}`);
  if (s0 < 0 || s0 + n > d.M.ephem.n) fail(`date and duration do not fit native coverage for ${d.entry.name}`);
  return { key: d.entry.id, name: d.entry.name, label: d.entry.name, short: d.entry.name.slice(0, 15), title: d.entry.name, d, aim, s0, n, ok: true };
}
function publicCmpRow(w, duration, p, drift) {
  const v = w.v, st = w.st;
  return {
    site: { id: w.d.entry.id, name: w.d.entry.name },
    start_date: nativeTime(w.d, w.s0),
    duration_days: duration,
    sun_pct: round(st.sun[w.aim], 2),
    earth_pct: round(st.earth[w.aim], 2),
    sun_gap_h: round(st.sunGap[w.aim], 2),
    earth_gap_h: round(st.earthGap[w.aim], 2),
    acceptable_pct: finite(w.share) ? round(100 * w.share, 2) : null,
    best_acceptable_pct: finite(w.best) ? round(100 * w.best, 2) : null,
    pass: !!v.pass,
    conditions: conditions(w.d, st, w.aim, p),
    effective: { site: w.d.entry.id, site_name: w.d.entry.name, start_date: nativeTime(w.d, w.s0), duration_days: duration, drift_m: drift, arrival_delay_days: 0, aim_index: w.aim, profile: p }
  };
}
function compareTool(args, context) {
  if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 8) fail("items must contain between 1 and 8 site/date entries");
  const assumed = [], first = args.items[0], firstSite = siteOf(first?.site), base = effectiveFor({ ...args, site: first?.site, start_date: first?.start_date, duration_days: args.duration_days ?? args.durationDays }, context, "compare", firstSite, assumed);
  const p = base.profile, rows = args.items.map((item) => {
    if (!item || typeof item !== "object") fail("each compare item must be an object");
    const d = siteOf(item.site);
    const sameSite = context?.site && siteOf(context.site).entry.id === d.entry.id;
    return rowFor(d, dateValue(item.start_date ?? item.startDate, "items[].start_date"), base.duration_days, p, base.drift_m, item.aim_index ?? item.aimIndex ?? (sameSite ? context?.aimIndex : void 0));
  });
  const result = compare(rows, base.drift_m, p, "site/date");
  const publicRows = result.rows.map((r) => publicCmpRow(r, base.duration_days, p, base.drift_m));
  const bestIndex = result.best ? result.rows.indexOf(result.best) : null;
  const flip = result.flip ? { r: result.flip.r, from: { site: { id: result.flip.from.d.entry.id, name: result.flip.from.d.entry.name }, index: result.rows.indexOf(result.flip.from) }, to: { site: { id: result.flip.to.d.entry.id, name: result.flip.to.d.entry.name }, index: result.rows.indexOf(result.flip.to) } } : null;
  const timeline = Array.from({ length: base._n }, (_, i) => ({ sample: i, offset_minutes: i * firstSite.M.ephem.step_min, relative_utc: nativeTime(firstSite, base._s0 + i) }));
  return wrapper("compare", base, assumed, { rows: publicRows, shared_timeline: timeline, best: bestIndex === null ? null : { index: bestIndex, ...publicRows[bestIndex] }, flip, native_summary: result.text });
}
function findAlternatives(args, context) {
  const assumed = [], site = siteOf(args.site ?? context?.site), max = integerArg(args, ["max_delay_days", "maxDelayDays"], 14, "max_delay_days");
  if (max.value < 0 || max.value > 60) fail("max_delay_days must be between 0 and 60");
  const minSun = args.min_sun_pct ?? args.minSunPct, minEarth = args.min_earth_pct ?? args.minEarthPct;
  const patchedProfile = { ...args.profile ?? context?.profile ?? DEFAULT_PROFILE, ...minSun === void 0 ? {} : { minSun }, ...minEarth === void 0 ? {} : { minEarth } };
  const common = { ...args, site: site.entry.id, profile: patchedProfile }, e = effectiveFor(common, context, "find_alternatives", site, assumed);
  const top = integerArg(args, ["top_n", "topN"], 5, "top_n");
  if (top.value < 1 || top.value > 5) fail("top_n must be between 1 and 5");
  const dateRows = [];
  const availableDays = Math.max(0, Math.floor((site.M.ephem.n - e._n - e._s0) * site.STEP_MS / 864e5));
  const scannedDays = Math.min(max.value, availableDays);
  for (let i = 1; i <= scannedDays; i++) dateRows.push(rowFor(site, new Date(e._s0 * site.STEP_MS + site.T0 + i * 864e5), e.duration_days, e.profile, e.drift_m, e.aim_index));
  const siteRows = SITES.filter((d) => d.entry.id !== site.entry.id).filter((d) => {
    const s0 = Math.round((Date.parse(e.start_date) - d.T0) / d.STEP_MS), n = Math.round(e.duration_days * 864e5 / d.STEP_MS) + 1;
    return s0 >= 0 && s0 + n <= d.M.ephem.n;
  }).map((d) => rowFor(d, new Date(e.start_date), e.duration_days, e.profile, e.drift_m));
  const dateCmp = compare(dateRows, e.drift_m, e.profile, "date"), siteCmp = compare(siteRows, e.drift_m, e.profile, "site");
  const score = (w) => [finite(w.share) ? w.share : -1, w.v?.pass ? 1 : 0, finite(w.st?.sun[w.aim]) ? w.st.sun[w.aim] : -1];
  const better = (a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return 0;
  };
  const sortRows = (rows) => [...rows].sort(better).slice(0, top.value).map((r) => {
    const out = publicCmpRow(r, e.duration_days, e.profile, e.drift_m);
    const baselineSt = statsFor(site, e._s0, e._n);
    return { ...out, delta_sun_pct: round((out.sun_pct ?? NaN) - baselineSt.sun[e.aim_index], 2), delta_earth_pct: round((out.earth_pct ?? NaN) - baselineSt.earth[e.aim_index], 2) };
  });
  return wrapper("find_alternatives", e, assumed, { baseline: baselineBody(e), alternative_dates: sortRows(dateCmp.rows), alternative_sites: sortRows(siteCmp.rows), search: { requested_delay_days: max.value, same_site_days: scannedDays, coverage_limited: scannedDays < max.value, same_date_sites: siteRows.length, top_n: top.value, min_sun_pct: e.profile.minSun, min_earth_pct: e.profile.minEarth } });
}
function dispersionTool(args, context) {
  const assumed = [], site = siteOf(args.site ?? context?.site), e = effectiveFor(args, context, "dispersion", site, assumed), st = statsFor(site, e._s0, e._n), pg = passFor(site, st, e.profile);
  const d = dispersionJson(site, pg, e.aim_index, e.drift_m);
  return wrapper("dispersion", e, assumed, { dispersion: d, curve: d.curve, flip: d.flip });
}
function dispatch(tool, args, context) {
  if (!VALID_TOOLS.has(tool)) fail(`Unknown tool '${tool}'. Valid tools: ${Array.from(VALID_TOOLS).join(", ")}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) fail("tool args must be an object");
  if (tool === "list_sites") return { tool, effective: {}, defaults_assumed: [], sites: SITES.map((d) => ({ id: d.entry.id, name: d.entry.name, coverage_start_utc: nativeTime(d, 0), coverage_end_utc: nativeTime(d, d.M.ephem.n - 1), description: d.entry.description, source: d.entry.source })), defaults: { duration_days: 10, drift_m: 100, profile: { ...DEFAULT_PROFILE }, date: "first_covered_date" }, glossary: Object.values(GLOSSARY) };
  if (tool === "get_baseline") return getBaseline(args, context);
  if (tool === "run_scenario") return runScenario(args, context);
  if (tool === "compare") return compareTool(args, context);
  if (tool === "find_alternatives") return findAlternatives(args, context);
  return dispersionTool(args, context);
}
var rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
    const result = dispatch(String(request.tool ?? ""), request.args ?? {}, request.context);
    process.stdout.write(JSON.stringify({ id: request.id ?? null, result: publicValue(result) }) + "\n");
  } catch (error) {
    const message = String(error?.message ?? error).replace(/[\r\n].*$/s, "").replace(/\b(?:\/[^ ]+|[A-Za-z]:\\[^ ]+)\b/g, "[path]").slice(0, 500);
    process.stdout.write(JSON.stringify({ id: request?.id ?? null, error: message || "Engine request failed" }) + "\n");
  }
});
