import { Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { Store } from '../../core/store';
import { CmpRow, pct } from '../../core/analysis';
import { drawCmpTimeline } from '../../core/draw';
import { fmt } from '../../core/engine';
import { goSection } from '../../core/nav';

@Component({
  selector: 'app-compare',
  imports: [NgTemplateOutlet],
  templateUrl: './compare.html',
})
export class Compare {
  protected readonly s = inject(Store);
  protected readonly fmt = fmt; protected readonly pct = pct;
  private readonly siteTl = viewChild.required<ElementRef<HTMLCanvasElement>>('siteTl');
  private readonly dateTl = viewChild.required<ElementRef<HTMLCanvasElement>>('dateTl');

  constructor() {
    effect(() => { const r = this.s.siteCompare(); drawCmpTimeline(this.siteTl().nativeElement, r.rows, r.best, this.s.site().STEP_MS); });
    effect(() => { const r = this.s.dateCompare(); drawCmpTimeline(this.dateTl().nativeElement, r.rows, r.best, this.s.site().STEP_MS); });
  }
  failList(w: CmpRow) { return w.v!.reasons.filter((r) => !r.ok).map((r) => r.label.toLowerCase()).join(', '); }
  openSite(w: CmpRow) { this.s.selectSite(w.key); goSection('mission'); }
  openDate(w: CmpRow) { if (w.value) { this.s.setStart(w.value); goSection('mission'); } }
  setDate(i: number, e: Event) { this.s.setCmpDate(i, (e.target as HTMLInputElement).value); }
}
