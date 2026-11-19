// Shared session state (site, window, profile, drift, delay, aim) kept across every page.
import { Injectable, computed, signal } from '@angular/core';
import { CmpRow, arrivalShift, compare, windows } from './analysis';
import {
  Profile, SiteData, bestAim, dispersionCurve, flipPoint, idxTime, iso, latlonStr, loadAll, locate, margin, passFor,
  reasonText, runs, spot, spotLatlon, statsFor, verdict, visSeries,
} from './engine';

const LS_KEY = 'shotspot.session.v1';

export interface PlannerBaseline {
  context: string;
  beforeAim: number;
  afterAim: number;
  beforeShare: number;
  afterShare: number;
  savedUtc: string;
}

@Injectable({ providedIn: 'root' })
export class Store {
  // ---------------- data
  readonly sites = signal<SiteData[]>([]);
  readonly ready = signal(false);
  readonly error = signal<string | null>(null);

  // ---------------- inputs
  readonly siteId = signal('');
  readonly startInput = signal('2026-12-13T00:00');
  readonly durDays = signal(10);
  readonly profile = signal<Profile>({ minSun: 40, minEarth: 50, maxSunGap: 72, maxEarthGap: 48, maxSlope: 8, conservative: false });
  readonly drift = signal(100);
  readonly delayH = signal(0);
  readonly aims = signal<Record<string, number>>({});   // aim point per site (spot index)
  readonly selSpot = signal(-1);                         // -1 = follow the aim
  readonly cursor = signal(0);
  readonly simple = signal(false);
  readonly cmpDates = signal(['2026-12-01T00:00', '2026-12-13T00:00', '2026-12-20T00:00']);
  private readonly plannerBaselineState = signal<PlannerBaseline | null>(null);

  /** last valid analysis window (an invalid input keeps the previous results on screen) */
  readonly win = signal({ s0: 0, n: 1441 });
  readonly windowMsg = signal<{ bad: boolean; text: string }>({ bad: false, text: '' });

  // ---------------- derived
  readonly site = computed(() => this.sites().find((s) => s.entry.id === this.siteId()) ?? this.sites()[0]);
  readonly aim = computed(() => { const d = this.site(); return d ? this.aims()[d.entry.id] ?? d.defaultAim : 0; });
  readonly spotK = computed(() => (this.selSpot() >= 0 ? this.selSpot() : this.aim()));
  readonly stats = computed(() => statsFor(this.site(), this.win().s0, this.win().n));
  readonly pass = computed(() => passFor(this.site(), this.stats(), this.profile()));
  readonly curve = computed(() => dispersionCurve(this.site(), this.pass(), this.aim()));
  readonly flip = computed(() => flipPoint(this.site(), this.curve()));
  readonly best = computed(() => bestAim(this.site(), this.drift(), this.pass(), this.aim()));
  /** Baseline survives the intentional before -> after aim change, but not unrelated context changes. */
  readonly plannerBaseline = computed(() => {
    const b = this.plannerBaselineState(), d = this.site();
    if (!b || !d || b.context !== this.plannerContext()) return null;
    const a = this.aim();
    if (a !== b.beforeAim && a !== b.afterAim) return null;
    return b;
  });
  readonly previousAim = computed(() => this.plannerBaseline()?.beforeAim ?? -1);
  readonly canApplyBest = computed(() => {
    const b = this.best(), a = this.aim();
    if (b.k < 0 || !(b.share > 0)) return false;
    return b.k !== a && !(Number.isFinite(b.nominal) && Number.isFinite(b.share) && b.share <= b.nominal + 1e-9);
  });
  readonly vis = computed(() => visSeries(this.site(), this.spotK(), this.win().s0, this.win().n));
  readonly spotVerdict = computed(() => verdict(this.site(), this.spotK(), this.stats(), this.profile()));
  readonly aimVerdict = computed(() => verdict(this.site(), this.aim(), this.stats(), this.profile()));
  readonly sunWin = computed(() => windows(this.site(), this.vis().sun, this.win().s0));
  readonly earthWin = computed(() => windows(this.site(), this.vis().ear, this.win().s0));
  readonly shift = computed(() => arrivalShift(this.site(), this.win().s0, this.win().n, this.aim(), this.drift(), this.profile(), this.delayH(), this.stats(), this.pass()));

  readonly siteCompare = computed(() => {
    const { s0, n } = this.win();
    const rows: CmpRow[] = this.sites().map((d) => {
      const [lat, lon] = spotLatlon(d, this.aimOf(d));
      return { key: d.entry.id, name: d.entry.name, label: d.entry.name, short: d.entry.name.slice(0, 15), title: latlonStr(lat, lon), d, aim: this.aimOf(d), s0, n, ok: true };
    });
    return compare(rows, this.drift(), this.profile(), 'site');
  });
  readonly dateCompare = computed(() => {
    const d = this.site(), n = this.win().n, names = ['A', 'B', 'C'];
    const rows: CmpRow[] = this.cmpDates().map((v, i) => {
      const t = Date.parse(v + ':00Z'), s0 = Math.round((t - d.T0) / d.STEP_MS);
      const ok = !!v && Number.isFinite(s0) && s0 >= 0 && s0 + n <= d.M.ephem.n;
      return { key: names[i], name: names[i], label: `${names[i]} (${v.slice(0, 10)})`, short: `${names[i]} ${v.slice(5, 10)}`,
        title: ok ? iso(idxTime(d, s0)) : v, value: v, d, aim: this.aim(), s0, n, ok,
        msg: v ? `Out of range: data covers ${iso(idxTime(d, 0)).slice(0, 10)} to ${iso(idxTime(d, d.M.ephem.n - n)).slice(0, 10)}` : 'Pick a date' };
    });
    return compare(rows, this.drift(), this.profile(), 'date');
  });

  readonly chip = computed(() => {
    const d = this.site(); if (!d) return '';
    const [lat, lon] = spotLatlon(d, this.aim());
    return `${d.M.site.name} · aim ${latlonStr(lat, lon, 4)}`;
  });

  aimOf(d: SiteData) { return this.aims()[d.entry.id] ?? d.defaultAim; }

  private plannerContext() {
    const p = this.profile(), w = this.win();
    return JSON.stringify({ site: this.siteId(), s0: w.s0, n: w.n, profile: p, drift: this.drift() });
  }

  private clearPlannerBaseline() { this.plannerBaselineState.set(null); }

  // ---------------- actions
  async init() {
    try {
      const all = await loadAll('data/');
      this.sites.set(all);
      this.restore();
      if (!this.siteId()) this.siteId.set(all[0].entry.id);
      this.applyWindow();
      this.ready.set(true);
    } catch (e: any) {
      this.error.set(e?.message ?? String(e));
    }
  }
  selectSite(id: string) { if (id !== this.siteId()) this.clearPlannerBaseline(); this.siteId.set(id); this.selSpot.set(-1); this.applyWindow(); this.save(); }
  setAim(k: number) {
    const d = this.site(); if (!d) return;
    if (!Number.isInteger(k) || k < 0 || k >= d.N) return;
    if (k !== this.aim()) this.clearPlannerBaseline();
    const id = d.entry.id; this.aims.update((a) => ({ ...a, [id]: k })); this.selSpot.set(-1); this.save();
  }
  resetAim() { const d = this.site(); if (!d) return; const id = d.entry.id; this.clearPlannerBaseline(); this.aims.update((a) => { const b = { ...a }; delete b[id]; return b; }); this.selSpot.set(-1); this.save(); }
  setProfile(p: Partial<Profile>) {
    const next = { ...this.profile(), ...p };
    if (JSON.stringify(next) !== JSON.stringify(this.profile())) this.clearPlannerBaseline();
    this.profile.set(next); this.save();
  }
  setDrift(v: number) { if (v !== this.drift()) this.clearPlannerBaseline(); this.drift.set(v); this.save(); }
  setDelay(v: number) { this.delayH.set(v); this.save(); }
  setStart(v: string) { if (v !== this.startInput()) this.clearPlannerBaseline(); this.startInput.set(v); this.applyWindow(); this.save(); }
  setDur(v: number) { if (v !== this.durDays()) this.clearPlannerBaseline(); this.durDays.set(v); this.applyWindow(); this.save(); }
  setCmpDate(i: number, v: string) { this.cmpDates.update((a) => a.map((x, j) => (j === i ? v : x))); this.save(); }
  toggleSimple() { this.simple.update((s) => !s); this.save(); }

  /** Apply the current best aim once, retaining the pre-application result for the planner comparison. */
  applyBest(): boolean {
    const d = this.site(), b = this.best(), before = this.aim();
    if (!d || b.k < 0 || !(b.share > 0) || b.k === before || (Number.isFinite(b.nominal) && Number.isFinite(b.share) && b.share <= b.nominal + 1e-9)) return false;
    this.plannerBaselineState.set({ context: this.plannerContext(), beforeAim: before, afterAim: b.k, beforeShare: b.nominal, afterShare: b.share, savedUtc: new Date().toISOString() });
    this.aims.update((a) => ({ ...a, [d.entry.id]: b.k }));
    this.selSpot.set(-1);
    this.save();
    return true;
  }

  /** validates landing time + duration against the precomputed data range (story 3) */
  applyWindow(): boolean {
    const d = this.site(); if (!d) return false;
    const t = Date.parse(this.startInput() + ':00Z'), days = this.durDays();
    const i0 = Math.round((t - d.T0) / d.STEP_MS), n = Math.round((days * 864e5) / d.STEP_MS) + 1;
    const range = `${iso(idxTime(d, 0))} to ${iso(idxTime(d, d.M.ephem.n - 1))}`;
    if (!Number.isFinite(t)) { this.windowMsg.set({ bad: true, text: 'Invalid date: enter a landing date and time (UTC). Results show the last valid window.' }); return false; }
    if (!Number.isFinite(i0) || i0 < 0 || i0 + n > d.M.ephem.n) {
      this.windowMsg.set({ bad: true, text: `Out of range: a ${days}-day window from ${iso(new Date(t))} does not fit in the precomputed data (${range}). Results show the last valid window.` });
      return false;
    }
    this.windowMsg.set({ bad: false, text: `Data covers ${iso(idxTime(d, 0)).slice(0, 10)} to ${iso(idxTime(d, d.M.ephem.n - 1)).slice(0, 10)} · sampling ${d.M.ephem.step_min} min · UTC.` });
    this.win.set({ s0: i0, n });
    this.cursor.update((c) => Math.min(c, n - 1));
    return true;
  }

  /** custom coordinates (story 2): only inside the precomputed area of a site */
  goCoords(lat: number, lon: number): { ok: boolean; text: string } {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -360 || lon > 360)
      return { ok: false, text: 'Enter a latitude between -90 and 90 and a longitude in degrees east.' };
    const { hit, nearest } = locate(this.sites(), lat, lon);
    if (!hit) return { ok: false, text: `Outside coverage: ${latlonStr(lat, lon)} is not inside any precomputed area (nearest: ${nearest!.d.entry.name}, ${(nearest!.dist / 1000).toFixed(1)} km from its aim point). No result is shown for this point.` };
    if (hit.d.entry.id !== this.siteId()) this.selectSite(hit.d.entry.id);
    this.setAim(hit.k);
    return { ok: true, text: `Inside ${hit.d.entry.name} coverage. Using the nearest analysis spot (${hit.snap.toFixed(0)} m away) as your aim point.` };
  }

  // ---------------- export (story 20)
  scenario() {
    const d = this.site(), a = this.aim(), v = this.aimVerdict(), st = this.stats(), stepMin = d.M.ephem.step_min, [lat, lon] = spotLatlon(d, a);
    const vs = visSeries(d, a, this.win().s0, this.win().n);
    const win = (arr: Uint8Array) => runs(arr).map(([s, e]) => ({ start_utc: idxTime(d, this.win().s0 + s).toISOString(), end_utc: idxTime(d, this.win().s0 + e).toISOString(), minutes: (e - s) * stepMin }));
    const b = this.best(), bs = b.k >= 0 ? spot(d, b.k) : null, currentAim = spot(d, a), f = this.flip(), baseline = this.plannerBaseline();
    return {
      tool: 'SHOTSPOT MVP', exported_utc: new Date().toISOString(),
      site: { id: d.entry.id, name: d.M.site.name, source: d.entry.source, aim_latlon_deg: [+lat.toFixed(5), +lon.toFixed(5)], aim_is_default: a === d.defaultAim },
      window: { landing_utc: idxTime(d, this.win().s0).toISOString(), duration_days: this.durDays(), sampling_min: stepMin, time_system: 'UTC' },
      mission_profile: { ...this.profile() }, drift_radius_m: this.drift(), arrival_shift_h: this.delayH(),
      results_at_aim: {
        verdict: v.pass ? 'PASS' : 'FAIL',
        conditions: v.reasons.map((r) => ({ condition: r.label, value: +r.value.toFixed(3), required: r.need, unit: r.unit, margin: +margin(r).toFixed(3), ok: r.ok, warning: !!r.warn })),
        reasons_failed: v.reasons.filter((r) => !r.ok).map(reasonText),
        sun_visible_pct: +st.sun[a].toFixed(2), earth_visible_pct: +st.earth[a].toFixed(2), sun_windows: win(vs.sun), earth_windows: win(vs.ear),
      },
      dispersion: { acceptable_at_aim_pct: Number.isFinite(b.nominal) ? +(100 * b.nominal).toFixed(1) : null, acceptable_at_best_aim_pct: +(100 * b.share).toFixed(1),
        best_aim_offset_m: bs ? [bs.x, bs.y] : null, best_aim_offset_reference: 'site grid origin',
        best_aim_relative_to_current_m: bs ? [bs.x - currentAim.x, bs.y - currentAim.y] : null,
        best_aim_movement_m: bs ? Math.hypot(bs.x - currentAim.x, bs.y - currentAim.y) : null,
        decision_flip_m: f ? f.r : null, decision_flip_description: 'first sampled crossover; rankings may change again' },
      planner_baseline: baseline ? { before_aim_spot_index: baseline.beforeAim, after_aim_spot_index: baseline.afterAim,
        before_acceptable_at_aim_pct: Number.isFinite(baseline.beforeShare) ? +(100 * baseline.beforeShare).toFixed(1) : null,
        after_acceptable_at_aim_pct: Number.isFinite(baseline.afterShare) ? +(100 * baseline.afterShare).toFixed(1) : null,
        applied_utc: baseline.savedUtc } : null,
      explanations: { delayed_arrival: this.shift().msg, compare_sites: this.siteCompare().text, compare_dates: this.dateCompare().text },
      assumptions: d.M.assumptions, sources: d.M.sources, validation_vs_jpl_horizons: d.M.validation_vs_jpl_horizons,
      metadata: { terrain_res_m: d.M.hillshade.res, spot_spacing_m: d.M.spots.spacing_m, horizon: d.M.horizon, ephemeris: { source: d.M.ephem.source, start_utc: d.M.ephem.start_utc, step_min: stepMin } },
    };
  }
  exportJson() {
    const blob = new Blob([JSON.stringify(this.scenario(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `shotspot_${this.site().entry.id}_${this.startInput().replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------- per-viewer persistence (convenience only; the app works without it)
  private save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ siteId: this.siteId(), start: this.startInput(), dur: this.durDays(), profile: this.profile(),
        drift: this.drift(), delay: this.delayH(), aims: this.aims(), simple: this.simple(), cmp: this.cmpDates(), baseline: this.plannerBaselineState() }));
    } catch { /* storage may be blocked */ }
  }
  private restore() {
    try {
      const s = JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); if (!s) return;
      if (this.sites().some((d) => d.entry.id === s.siteId)) this.siteId.set(s.siteId);
      if (typeof s.start === 'string') this.startInput.set(s.start);
      if (s.dur) this.durDays.set(+s.dur);
      if (s.profile) this.profile.set({ ...this.profile(), ...s.profile });
      if (Number.isFinite(s.drift)) this.drift.set(s.drift);
      if (Number.isFinite(s.delay)) this.delayH.set(s.delay);
      if (s.aims) this.aims.set(s.aims);
      this.simple.set(!!s.simple);
      if (Array.isArray(s.cmp) && s.cmp.length === 3) this.cmpDates.set(s.cmp);
      if (s.baseline && typeof s.baseline.context === 'string' && Number.isInteger(s.baseline.beforeAim) && Number.isInteger(s.baseline.afterAim)) {
        this.plannerBaselineState.set({ context: s.baseline.context, beforeAim: s.baseline.beforeAim, afterAim: s.baseline.afterAim,
          beforeShare: +s.baseline.beforeShare, afterShare: +s.baseline.afterShare, savedUtc: typeof s.baseline.savedUtc === 'string' ? s.baseline.savedUtc : new Date().toISOString() });
      }
    } catch { /* ignore */ }
  }
}
