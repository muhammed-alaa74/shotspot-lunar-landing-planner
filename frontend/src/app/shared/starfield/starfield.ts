import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, ViewChild, inject } from '@angular/core';

interface Star { x: number; y: number; z: number; r: number; tw: number; ph: number; }
interface Meteor { x: number; y: number; vx: number; vy: number; life: number; }

/** Animated deep-space background: parallax star layers, twinkle and occasional shooting stars.
 *  Runs outside Angular, pauses when the tab is hidden and draws a still frame for reduced motion. */
@Component({
  selector: 'app-starfield',
  template: `<canvas #cv aria-hidden="true"></canvas>`,
  styles: [`:host { position: absolute; inset: 0; display: block; overflow: hidden; } canvas { inline-size: 100%; block-size: 100%; background: transparent; border-radius: 0; }`],
})
export class Starfield implements AfterViewInit, OnDestroy {
  @ViewChild('cv', { static: true }) cv!: ElementRef<HTMLCanvasElement>;
  private readonly zone = inject(NgZone);
  private stars: Star[] = []; private meteors: Meteor[] = [];
  private raf = 0; private W = 0; private H = 0; private dpr = 1; private mx = 0; private my = 0; private t0 = performance.now();
  private ro?: ResizeObserver;
  private readonly reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly onMove = (e: PointerEvent) => { this.mx = e.clientX / innerWidth - 0.5; this.my = e.clientY / innerHeight - 0.5; };
  private readonly onVis = () => { if (document.hidden) cancelAnimationFrame(this.raf); else if (!this.reduce) this.loop(); };

  ngAfterViewInit() {
    this.zone.runOutsideAngular(() => {
      this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.cv.nativeElement);
      this.resize();
      addEventListener('pointermove', this.onMove, { passive: true });
      document.addEventListener('visibilitychange', this.onVis);
      this.reduce ? this.frame(0) : this.loop();
    });
  }
  ngOnDestroy() {
    cancelAnimationFrame(this.raf); this.ro?.disconnect();
    removeEventListener('pointermove', this.onMove); document.removeEventListener('visibilitychange', this.onVis);
  }
  private resize() {
    const c = this.cv.nativeElement, r = c.getBoundingClientRect();
    this.dpr = Math.min(devicePixelRatio || 1, 2); this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    c.width = this.W * this.dpr; c.height = this.H * this.dpr;
    const count = Math.min(900, Math.round((this.W * this.H) / 1600));
    this.stars = Array.from({ length: count }, () => ({ x: Math.random(), y: Math.random(), z: Math.random() ** 2, r: 0.3 + Math.random() * 1.2, tw: 0.5 + Math.random() * 2, ph: Math.random() * 6.28 }));
    if (this.reduce) this.frame(0);
  }
  private loop = () => { this.frame((performance.now() - this.t0) / 1000); this.raf = requestAnimationFrame(this.loop); };
  private frame(t: number) {
    const g = this.cv.nativeElement.getContext('2d')!, W = this.W, H = this.H;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, W, H);
    for (const s of this.stars) {
      const depth = 0.2 + s.z * 0.8, drift = (t * 4 * depth) % W;
      const x = (((s.x * W - drift - this.mx * 30 * depth) % W) + W) % W, y = s.y * H - this.my * 20 * depth;
      const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * s.tw + s.ph)) * depth;
      g.globalAlpha = a; g.fillStyle = s.z > 0.85 ? '#cfe6ff' : '#ffffff';
      g.beginPath(); g.arc(x, y, s.r * depth + 0.2, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1;
    if (!this.reduce && Math.random() < 0.006 && this.meteors.length < 2)
      this.meteors.push({ x: W * (0.3 + Math.random() * 0.7), y: H * Math.random() * 0.4, vx: -(6 + Math.random() * 5), vy: 2.5 + Math.random() * 2, life: 1 });
    this.meteors = this.meteors.filter((m) => m.life > 0);
    for (const m of this.meteors) {
      const grad = g.createLinearGradient(m.x, m.y, m.x - m.vx * 14, m.y - m.vy * 14);
      grad.addColorStop(0, `rgba(255,255,255,${m.life})`); grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.strokeStyle = grad; g.lineWidth = 1.6; g.beginPath(); g.moveTo(m.x, m.y); g.lineTo(m.x - m.vx * 14, m.y - m.vy * 14); g.stroke();
      m.x += m.vx; m.y += m.vy; m.life -= 0.018;
    }
  }
}
