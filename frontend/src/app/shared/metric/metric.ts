import { Component, OnDestroy, effect, input, signal } from '@angular/core';

@Component({
  selector: 'app-metric',
  template: `<span [attr.aria-label]="label()">{{ shown() }}<span class="unit">{{ suffix() }}</span></span>`,
  styles: [`:host { display: inline; font-variant-numeric: tabular-nums; } .unit { font-size: .48em; margin-left: .08em; }`],
})
export class Metric implements OnDestroy {
  readonly value = input.required<number>();
  readonly suffix = input('%');
  readonly decimals = input(0);
  readonly label = input('');
  protected readonly shown = signal('–');
  private current = NaN;
  private raf = 0;
  constructor() {
    effect(() => {
      const target = this.value(), decimals = this.decimals();
      cancelAnimationFrame(this.raf);
      if (!Number.isFinite(target)) { this.shown.set('–'); this.current = NaN; return; }
      const from = Number.isFinite(this.current) ? this.current : target;
      const start = performance.now(), duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650;
      const frame = (time: number) => {
        const t = duration ? Math.min(1, (time - start) / duration) : 1;
        this.current = from + (target - from) * (1 - Math.pow(1 - t, 3));
        this.shown.set(this.current.toFixed(decimals));
        if (t < 1) this.raf = requestAnimationFrame(frame);
      };
      frame(start);
    });
  }
  ngOnDestroy() { cancelAnimationFrame(this.raf); }
}
