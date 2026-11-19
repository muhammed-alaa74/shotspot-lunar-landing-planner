import { Directive, ElementRef, OnDestroy, OnInit, inject, input } from '@angular/core';

/** Counts the leading number of a value up from 0 when it scrolls into view ("52,561" → 0…52,561). */
@Directive({ selector: '[appCountUp]' })
export class CountUp implements OnInit, OnDestroy {
  readonly appCountUp = input.required<string>();
  private readonly el = inject(ElementRef<HTMLElement>);
  private io?: IntersectionObserver; private raf = 0;
  ngOnInit() {
    const node = this.el.nativeElement as HTMLElement, text = this.appCountUp();
    node.textContent = text;
    const m = text.match(/^([^\d]*)([\d,]+(?:\.\d+)?)(.*)$/);
    if (!m || matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const [, pre, num, post] = m, target = parseFloat(num.replace(/,/g, '')), dec = (num.split('.')[1] ?? '').length, comma = num.includes(',');
    const show = (v: number) => { const s = v.toFixed(dec); node.textContent = pre + (comma ? (+s).toLocaleString('en-US', { minimumFractionDigits: dec }) : s) + post; };
    show(0);
    this.io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      this.io?.disconnect();
      const t0 = performance.now(), D = 1400;
      const step = (t: number) => { const f = Math.min(1, (t - t0) / D), ease = 1 - Math.pow(1 - f, 3); show(target * ease); if (f < 1) this.raf = requestAnimationFrame(step); else node.textContent = text; };
      this.raf = requestAnimationFrame(step);
    }, { threshold: 0.4 });
    this.io.observe(node);
  }
  ngOnDestroy() { this.io?.disconnect(); cancelAnimationFrame(this.raf); }
}
