import { Component, ElementRef, computed, effect, inject, viewChild } from '@angular/core';
import { Store } from '../../core/store';
import { drawCurve } from '../../core/draw';
import { fmt, iso, spot, spotDistance } from '../../core/engine';
import { pct } from '../../core/analysis';
import { goSection } from '../../core/nav';
import { LandingMap } from '../../shared/landing-map/landing-map';

@Component({
  selector: 'app-landing',
  imports: [LandingMap],
  templateUrl: './landing.html',
  styleUrl: './landing.css',
})
export class Landing {
  protected readonly s = inject(Store);
  protected readonly fmt = fmt; protected readonly iso = iso; protected readonly pct = pct;
  private readonly curve = viewChild<ElementRef<HTMLCanvasElement>>('curve');

  protected readonly disp = computed(() => {
    const b = this.s.best(), d = this.s.site(), drift = this.s.drift(), f = this.s.flip();
    if (!(b.share > 0)) return { none: true, nom: '0%', best: '0%', where: 'no spot works', flip: 'n/a', canApply: false,
      text: 'No spot in the analysis area meets the mission profile in this window, so no aim point helps. Try another date or relax the profile.' };
    const dist = spotDistance(d, this.s.aim(), b.k), canApply = this.s.canApplyBest();
    const text = drift === 0 ? 'With a perfect landing, only the single aim spot matters.'
      : !canApply ? `Under a uniform circular drift of ${drift} m, ${fmt(100 * b.nominal, 0)}% of the possible analyzed spots meet the profile. Your current aim is already the best analyzed aim for this drift radius.`
      : `Under a uniform circular drift of ${drift} m, ${fmt(100 * b.nominal, 0)}% of the possible analyzed spots meet the profile around your aim. `
        + `Aiming ${fmt(dist, 0)} m away raises that share to ${fmt(100 * b.share, 0)}%. `
        + (f ? `The first crossover is at ${f.r} m drift.` : 'The best aim point does not change between 25 m and 500 m of drift.');
    return { none: false, nom: Number.isFinite(b.nominal) ? `${fmt(100 * b.nominal, 0)}%` : 'n/a', best: `${fmt(100 * b.share, 0)}%`,
      where: `${fmt(dist, 0)} m from your aim`, flip: f ? `${f.r} m` : 'none in range', text, canApply };
  });
  protected readonly selLabel = computed(() => {
    const k = this.s.spotK(); if (k === this.s.aim()) return 'your aim point';
    const d = this.s.site(), p = spot(d, k), a = spot(d, this.s.aim());
    return `spot ${fmt(p.x - a.x, 0)} m east, ${fmt(p.y - a.y, 0)} m north of your aim`;
  });
  protected readonly isDefaultAim = computed(() => this.s.aim() === this.s.site().defaultAim);

  constructor() {
    effect(() => {
      const curve = this.curve();
      if (curve) drawCurve(curve.nativeElement, this.s.curve(), this.s.flip(), this.s.drift());
    });
  }
  go(id: string) { goSection(id); }
  selectSpot(k: number) { if (Number.isInteger(k) && k >= 0 && k < this.s.site().N) this.s.selSpot.set(k); }
  useBest() { this.s.applyBest(); }
  aimHere() { this.s.setAim(this.s.spotK()); }
  sgn(x: number, d = 1) { return `${x > 0 ? '+' : x < 0 ? '−' : '±'}${fmt(Math.abs(x), d)}`; }
}
