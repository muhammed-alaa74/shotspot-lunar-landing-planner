import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { Store } from '../../core/store';
import { drawSiteMap } from '../../core/draw';
import { fmt, latlonStr } from '../../core/engine';
import { goSection } from '../../core/nav';

@Component({
  selector: 'app-sites',
  templateUrl: './sites.html',
  styles: [`
    .site-list { display: grid; gap: var(--sp-3); }
    .site-item { display: grid; gap: var(--sp-1); padding: var(--sp-4); border-radius: var(--r-md); border: 1px solid var(--c-border); background: var(--c-bg); text-align: start; color: var(--c-text); font: inherit; cursor: pointer; transition: border-color .2s, background .2s; }
    .site-item:hover { border-color: var(--c-border-2); }
    .site-item.on { border-color: var(--c-accent); background: var(--c-surface-2); }
    .site-item h3 { font-size: 15px; display: flex; justify-content: space-between; gap: var(--sp-2); }
    .site-item p { font-size: 13px; color: var(--c-text-2); }
    .stats { display: flex; flex-wrap: wrap; gap: var(--sp-3); font: 12px var(--font-mono); color: var(--c-text-2); }
    .overview canvas { cursor: pointer; border: 1px solid var(--c-border); }
    .coord-row { display: grid; grid-template-columns: 1fr 1fr auto; gap: var(--sp-3); align-items: end; }
    @media (max-width: 600px) { .coord-row { grid-template-columns: 1fr; } }
  `],
})
export class Sites {
  protected readonly s = inject(Store);
  protected readonly fmt = fmt; protected readonly latlonStr = latlonStr;
  private readonly cv = viewChild.required<ElementRef<HTMLCanvasElement>>('cv');
  private pts: { id: string; x: number; y: number }[] = [];
  protected readonly lat = signal(''); protected readonly lon = signal('');
  protected readonly msg = signal<{ ok: boolean; text: string } | null>(null);

  constructor() { effect(() => { this.pts = drawSiteMap(this.cv().nativeElement, this.s.sites(), this.s.site().entry.id); }); }
  pick(e: MouseEvent) {
    const c = this.cv().nativeElement, r = c.getBoundingClientRect(), x = (e.clientX - r.left) * (c.width / r.width), y = (e.clientY - r.top) * (c.height / r.height);
    let best: string | null = null, bd = 40;
    for (const p of this.pts) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p.id; } }
    if (best) this.s.selectSite(best);
  }
  analyze() { this.msg.set(this.s.goCoords(parseFloat(this.lat()), parseFloat(this.lon()))); }
  go(id: string) { goSection(id); }
  v(e: Event) { return (e.target as HTMLInputElement).value; }
}
