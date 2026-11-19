import { Component, ElementRef, OnDestroy, effect, input, output, viewChild } from '@angular/core';
import { drawMap, mapPick } from '../../core/draw';
import { SiteData, spot } from '../../core/engine';

/** Presentation interpolation only. Terrain, pass/fail and the final aim all come from the engine. */
@Component({
  selector: 'app-landing-map',
  template: `<canvas #canvas width="860" height="860" [attr.tabindex]="readOnly() ? null : 0"
    [attr.aria-label]="readOnly() ? 'Terrain map: green meets the profile; dim fill falls short; dashed circle is assumed drift, crosshair is current aim; mint is recommended aim. Faint purple marks weak terrain.' : 'Landing terrain map. Click a spot or use arrow keys to inspect. Green meets the profile; dim fill falls short; dashed circle is assumed drift and crosshair is current aim. Faint purple marks weak terrain.'"
    (click)="pick($event)" (keydown)="onKey($event)"></canvas>`,
  styles: [`:host { display: block; width: 100%; } canvas { width: 100%; height: auto; aspect-ratio: 1; border-radius: 14px; background: #080c13; } canvas:focus-visible { outline: 3px solid #58b4f7; outline-offset: 3px; }`],
})
export class LandingMap implements OnDestroy {
  readonly data = input.required<SiteData>();
  readonly pass = input.required<Uint8Array>();
  readonly aim = input.required<number>();
  readonly best = input(-1);
  readonly drift = input.required<number>();
  readonly previousAim = input(-1);
  readonly readOnly = input(false);
  readonly spotSelected = output<number>();
  private readonly canvas = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly reduced = matchMedia('(prefers-reduced-motion: reduce)');
  private raf = 0;
  private current?: { x: number; y: number; r: number; site: string };
  private selected = -1;
  private lastAim = -1;
  private resizeObserver?: ResizeObserver;

  constructor() {
    effect(() => {
      const cv = this.canvas()?.nativeElement;
      const d = this.data(), pg = this.pass(), aim = this.aim(), best = this.best();
      const radius = this.drift(), previousAim = this.previousAim();
      if (!cv) return;
      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.redraw());
        this.resizeObserver.observe(cv);
      }
      cancelAnimationFrame(this.raf);
      if (this.lastAim !== aim || this.current?.site !== d.entry.id) this.selected = -1;
      this.lastAim = aim;
      const target = spot(d, aim);
      const from = this.current?.site === d.entry.id ? { ...this.current } : { x: target.x, y: target.y, r: radius, site: d.entry.id };
      const start = performance.now(), duration = this.reduced.matches ? 0 : 850;
      const frame = (time: number) => {
        const t = duration ? Math.min(1, (time - start) / duration) : 1;
        const ease = 1 - Math.pow(1 - t, 3);
        this.current = { x: from.x + (target.x - from.x) * ease, y: from.y + (target.y - from.y) * ease,
          r: from.r + (radius - from.r) * ease, site: d.entry.id };
        drawMap(cv, d, pg, { aim, best, sel: this.selected >= 0 ? this.selected : aim,
          drift: this.current.r, aimXY: [this.current.x, this.current.y], previousAim });
        if (t < 1) this.raf = requestAnimationFrame(frame);
      };
      frame(start);
    });
  }

  pick(event: MouseEvent) {
    if (this.readOnly()) return;
    const cv = this.canvas()?.nativeElement;
    if (!cv) return;
    const k = mapPick(cv, this.data(), event);
    if (k >= 0) this.select(k);
  }

  onKey(event: KeyboardEvent) {
    if (this.readOnly()) return;
    const d = this.data(), current = this.selected >= 0 ? this.selected : this.aim();
    const offsets: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -d.COLS, ArrowDown: d.COLS };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    const next = current + offsets[event.key];
    if (next < 0 || next >= d.N || (event.key === 'ArrowLeft' && current % d.COLS === 0) || (event.key === 'ArrowRight' && current % d.COLS === d.COLS - 1)) return;
    this.select(next);
  }

  private select(k: number) {
    this.selected = k; this.spotSelected.emit(k);
    const cv = this.canvas()?.nativeElement;
    if (cv) drawMap(cv, this.data(), this.pass(), { aim: this.aim(), best: this.best(), sel: k, drift: this.drift(), previousAim: this.previousAim() });
  }
  private redraw() {
    const cv = this.canvas()?.nativeElement;
    if (!cv) return;
    const c = this.current;
    drawMap(cv, this.data(), this.pass(), { aim: this.aim(), best: this.best(), sel: this.selected >= 0 ? this.selected : this.aim(),
      drift: c?.r ?? this.drift(), aimXY: c ? [c.x, c.y] : undefined, previousAim: this.previousAim() });
  }
  ngOnDestroy() { cancelAnimationFrame(this.raf); this.resizeObserver?.disconnect(); }
}
