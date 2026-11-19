import { Component, ElementRef, OnDestroy, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Store } from '../../core/store';
import { goSection } from '../../core/nav';
import { drawSky, drawTimeline, timelineLeft } from '../../core/draw';
import { dur, fmt, idxTime, iso, margin, nextChange, reasonText, spot } from '../../core/engine';
import { SkyOverview } from '../../shared/sky-overview/sky-overview';

@Component({
  selector: 'app-mission',
  imports: [SkyOverview],
  templateUrl: './mission.html',
})
export class Mission implements OnDestroy {
  protected readonly s = inject(Store);
  protected readonly fmt = fmt; protected readonly iso = iso; protected readonly margin = margin; protected readonly abs = Math.abs;
  private readonly sky = viewChild.required<ElementRef<HTMLCanvasElement>>('sky');
  private readonly tl = viewChild.required<ElementRef<HTMLCanvasElement>>('tl');
  protected readonly playing = signal(false);
  private timer: ReturnType<typeof setInterval> | null = null;

  protected readonly now = computed(() => iso(idxTime(this.s.site(), this.s.win().s0 + this.s.cursor())));
  protected readonly where = computed(() => {
    const k = this.s.spotK(); if (k === this.s.aim()) return 'your aim point';
    const p = spot(this.s.site(), k); return `spot ${fmt(p.x, 0)} m, ${fmt(p.y, 0)} m from your aim`;
  });
  protected readonly counts = computed(() => {
    const d = this.s.site(), vs = this.s.vis(), c = this.s.cursor(), { s0, n } = this.s.win(), k = this.s.spotK();
    return (['sun', 'earth'] as const).map((w) => {
      const visNow = (w === 'sun' ? vs.sun : vs.ear)[c] === 1, ch = nextChange(d, k, w, vs, c, s0, n);
      const name = w === 'sun' ? 'Sun' : 'Earth', next = visNow ? (w === 'sun' ? 'sunset' : 'Earthset') : (w === 'sun' ? 'sunrise' : 'Earthrise');
      return { cls: w, label: `${name} is ${visNow ? 'visible' : 'blocked'} now · next ${next} in`, value: ch ? dur(ch.ms) : 'no change in the analyzed period' };
    });
  });
  protected readonly fails = computed(() => this.s.spotVerdict().reasons.filter((r) => !r.ok).map(reasonText));
  protected readonly st = computed(() => { const st = this.s.stats(), k = this.s.spotK(); return { sun: st.sun[k], earth: st.earth[k], sunGap: st.sunGap[k], earthGap: st.earthGap[k] }; });
  protected readonly days = computed(() => fmt(((this.s.win().n - 1) * this.s.site().STEP_MS) / 864e5, 0));
  protected readonly winLabel = computed(() => `${iso(idxTime(this.s.site(), this.s.win().s0))} + ${this.days()} d`);
  protected readonly meta = computed(() => {
    const M = this.s.site().M;
    return `Sampling every ${M.ephem.step_min} min · time system UTC · terrain: LOLA ${M.hillshade.res} m/px (PGDA 78) + 120 m/px far field out to ${M.horizon.max_distance_km} km · Sun/Earth: NAIF SPICE (DE421), checked vs NASA JPL Horizons · visible = body center above the terrain horizon, observer ${M.horizon.observer_height_m} m above ground.`;
  });

  constructor() {
    effect(() => {
      const d = this.s.site(), { s0, n } = this.s.win(), k = this.s.spotK(), c = this.s.cursor(), vs = this.s.vis();
      drawSky(this.sky().nativeElement, d, k, s0, n, c);
      drawTimeline(this.tl().nativeElement, d, vs, c);
    });
  }
  go(id: string) { goSection(id); }
  setCursor(e: Event) { this.s.cursor.set(+(e.target as HTMLInputElement).value); }
  timelineClick(e: MouseEvent) {
    const cv = this.tl().nativeElement, r = cv.getBoundingClientRect(), L = timelineLeft(cv) * r.width;
    const f = (e.clientX - r.left - L) / (r.width - L);
    if (f >= 0 && f <= 1) this.s.cursor.set(Math.round(f * (this.s.win().n - 1)));
  }
  togglePlay() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; this.playing.set(false); return; }
    this.playing.set(true);
    this.timer = setInterval(() => this.s.cursor.update((c) => (c + 6) % this.s.win().n), 60);
  }
  ngOnDestroy() { if (this.timer) clearInterval(this.timer); }
}
