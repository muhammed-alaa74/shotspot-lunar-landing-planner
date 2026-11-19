import { Component, HostListener, OnDestroy, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store';
import { Profile, bestAim, diskOffsets, passFor, share, spot, statsFor, verdict } from '../../core/engine';
import { LandingMap } from '../../shared/landing-map/landing-map';
import { Metric } from '../../shared/metric/metric';
import { SkyOverview } from '../../shared/sky-overview/sky-overview';

const PROFILE: Profile = { minSun: 40, minEarth: 50, maxSunGap: 72, maxEarthGap: 48, maxSlope: 8, conservative: false };
const START = '2026-12-13T00:00';

/** A reproducible presentation scenario. It never overwrites the user's planner unless requested. */
@Component({
  selector: 'app-demo',
  imports: [RouterLink, LandingMap, Metric, SkyOverview],
  templateUrl: './demo.html',
  styleUrl: './demo.css',
})
export class Demo implements OnDestroy {
  protected readonly s = inject(Store);
  readonly exploreRequested = output<'sites' | 'mission' | 'landing'>();
  protected readonly stage = signal(0);
  protected readonly playing = signal(false);
  protected readonly elapsed = signal(0);
  protected readonly entering = signal(true);
  protected readonly feedback = signal('');
  protected readonly duration = 85;
  protected readonly steps = [
    { label: 'Aim', time: 15, title: 'Great point. Enough?', text: 'One good point isn’t a landing area.' },
    { label: 'Drift', time: 20, title: 'More drift. Less room.', text: 'Same aim. A wider landing area.' },
    { label: 'Better aim', time: 20, title: 'Find a better aim.', text: 'Same drift. Better coverage.' },
    { label: 'Move', time: 18, title: 'Move. Gain room.', text: 'New aim. Same mission.' },
    { label: 'Explore', time: 12, title: 'Your turn.', text: 'Your inputs. Your decision.' },
  ];
  protected readonly scene = computed(() => this.steps[this.stage()]);
  protected readonly data = computed(() => this.s.sites().find((d) => d.entry.id === 'Site20') ?? this.s.sites()[0]);
  protected readonly window = computed(() => {
    const d = this.data();
    return { s0: Math.round((Date.parse(START + ':00Z') - d.T0) / d.STEP_MS), n: Math.round(10 * 86400000 / d.STEP_MS) + 1 };
  });
  protected readonly days = computed(() => (this.window().n - 1) * this.data().STEP_MS / 86400000);
  protected readonly profile = signal<Profile>({ ...PROFILE });
  protected readonly driftOverride = signal<number | null>(null);
  protected readonly radius = computed(() => this.driftOverride() ?? (this.stage() === 0 ? 100 : 400));
  protected readonly landingDate = new Date(START + ':00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  protected readonly stats = computed(() => { const w = this.window(); return statsFor(this.data(), w.s0, w.n); });
  protected readonly pass = computed(() => passFor(this.data(), this.stats(), this.profile()));
  protected readonly originalAim = computed(() => this.data().defaultAim);
  protected readonly recommended = computed(() => bestAim(this.data(), this.radius(), this.pass(), this.originalAim()));
  protected readonly before = computed(() => share(this.data(), this.originalAim(), diskOffsets(this.data(), this.radius()), this.pass()));
  protected readonly aim = computed(() => this.stage() >= 3 && this.recommended().k >= 0 ? this.recommended().k : this.originalAim());
  protected readonly currentShare = computed(() => share(this.data(), this.aim(), diskOffsets(this.data(), this.radius()), this.pass()));
  protected readonly currentVerdict = computed(() => verdict(this.data(), this.aim(), this.stats(), this.profile()));
  protected readonly movement = computed(() => {
    if (this.recommended().k < 0) return NaN;
    const a = spot(this.data(), this.originalAim()), b = spot(this.data(), this.recommended().k);
    return Math.hypot(b.x - a.x, b.y - a.y);
  });
  protected readonly improvement = computed(() => 100 * (this.recommended().share - this.before()));
  private initialized = false;
  private timer?: ReturnType<typeof setInterval>;
  private intro?: ReturnType<typeof setTimeout>;
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');

  constructor() {
    effect(() => {
      if (this.s.ready() && !this.initialized) untracked(() => {
        this.initialized = true;
        this.beginIntro();
      });
    });
    effect(() => {
      if (this.stage() === 4) setTimeout(() => document.getElementById('demo-sky')?.scrollIntoView({ behavior: this.reduced.matches ? 'auto' : 'smooth', block: 'start' }), 60);
    });
  }

  private beginIntro() {
    if (this.reduced.matches) this.entering.set(false);
    else this.intro = setTimeout(() => this.entering.set(false), 1100);
  }

  protected play() {
    if (this.playing()) return;
    if (this.elapsed() >= this.duration) { this.restart(); return; }
    clearTimeout(this.intro); this.entering.set(false);
    const base = this.elapsed(), start = performance.now();
    this.playing.set(true);
    this.timer = setInterval(() => {
      const t = Math.min(this.duration, base + (performance.now() - start) / 1000);
      this.elapsed.set(t);
      let boundary = 0, index = this.steps.length - 1;
      for (let i = 0; i < this.steps.length; i++) { boundary += this.steps[i].time; if (t < boundary) { index = i; break; } }
      this.stage.set(index);
      if (t >= this.duration) this.pause();
    }, 160);
  }
  protected pause() { clearInterval(this.timer); this.timer = undefined; this.playing.set(false); }
  protected toggle() { this.playing() ? this.pause() : this.play(); }
  protected go(index: number) {
    if (index < 0 || index >= this.steps.length) return;
    clearTimeout(this.intro); this.entering.set(false); this.pause(); this.stage.set(index);
    this.elapsed.set(this.steps.slice(0, index).reduce((t, s) => t + s.time, 0));
  }
  protected next() { this.go(Math.min(this.stage() + 1, this.steps.length - 1)); }
  protected restart() {
    this.pause(); clearTimeout(this.intro); this.feedback.set(''); this.stage.set(0); this.elapsed.set(0); this.entering.set(true);
    this.driftOverride.set(null);
    this.beginIntro();
  }
  protected setDrift(event: Event) {
    this.pause();
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.driftOverride.set(Math.max(0, Math.min(500, Math.round(value))));
  }
  protected async fullScreen() {
    try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); }
    catch { this.feedback.set('Fullscreen is unavailable here. Open the downloaded app in a browser, or use your browser’s fullscreen command.'); }
  }
  protected explore(section: 'sites' | 'mission' | 'landing' = 'landing') {
    const d = this.data();
    this.pause(); clearTimeout(this.intro);
    this.s.selectSite(d.entry.id); this.s.setStart(START); this.s.setDur(this.days()); this.s.setProfile({ ...this.profile() });
    this.s.setDrift(this.radius()); this.s.setDelay(0);
    this.s.setAim(this.originalAim());
    if (this.stage() >= 3) this.s.applyBest();
    this.exploreRequested.emit(section);
  }
  protected exportResult() {
    const payload = {
      tool: 'SHOTSPOT — guided demo', exported_utc: new Date().toISOString(), site: this.data().entry,
      scenario: { landing_utc: START + ':00Z', duration_days: this.days(), mission_profile: this.profile(), drift_radius_m: this.radius() },
      comparison: { original_aim_index: this.originalAim(), recommended_aim_index: this.recommended().k,
        before_share_pct: 100 * this.before(), recommended_share_pct: 100 * this.recommended().share,
        gain_percentage_points: this.improvement(), aim_movement_m: this.movement() },
      model: 'Share of analyzed spots meeting the profile inside a uniform circular drift disk, not real mission-success probability.',
      assumptions: this.data().M.assumptions, sources: this.data().M.sources,
      validation_vs_jpl_horizons: this.data().M.validation_vs_jpl_horizons,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = 'SHOTSPOT-demo-comparison.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.feedback.set('Comparison exported with the scenario, assumptions and sources.');
  }
  protected print() { this.pause(); window.print(); }
  protected rounded(value: number) { return Number.isFinite(value) ? value.toFixed(0) : '–'; }
  @HostListener('document:visibilitychange') onVisibility() { if (document.hidden) this.pause(); }
  @HostListener('window:keydown', ['$event']) onKey(event: KeyboardEvent) {
    const tag = (event.target as HTMLElement)?.tagName;
    if (['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'A', 'SUMMARY'].includes(tag)) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); this.next(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); this.go(this.stage() - 1); }
    if (event.code === 'Space') { event.preventDefault(); this.toggle(); }
  }
  ngOnDestroy() { this.pause(); clearTimeout(this.intro); }
}
