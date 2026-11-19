import { Component, ElementRef, NgZone, OnDestroy, OnInit, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Store } from '../../core/store';
import { Reveal } from '../../shared/reveal/reveal';
import { Starfield } from '../../shared/starfield/starfield';
import { CountUp } from '../../shared/count-up/count-up';

interface Dot { x: number; y: number; ok: boolean; delay: number; }

@Component({
  selector: 'app-home',
  imports: [RouterLink, Starfield, Reveal, CountUp],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home implements OnInit, OnDestroy {
  protected readonly s = inject(Store);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  protected readonly facts = computed(() => {
    if (!this.s.ready()) return null;
    const d = this.s.sites()[0];
    if (!d) return null;
    const validation = d.M.validation_vs_jpl_horizons ?? {};
    const differences = Object.values<any>(validation)
      .map((x) => Math.max(Number(x.max_abs_daz_deg) || 0, Number(x.max_abs_del_deg) || 0));
    const maxDiff = Math.max(0, ...differences);
    return [
      { value: String(this.s.sites().length), label: 'curated south-pole site areas · PGDA 78' },
      { value: (d.M.ephem.n as number).toLocaleString('en-US'), label: `Sun & Earth positions per site · ${d.M.ephem.step_min} min sampling` },
      { value: `${d.M.horizon.max_distance_km} km`, label: 'terrain horizon scanned for every site' },
      { value: maxDiff < 1e-4 ? '< 0.0001°' : `${maxDiff.toFixed(4)}°`, label: 'maximum angle difference vs JPL Horizons' },
    ];
  });

  protected readonly liveResult = computed(() => {
    if (!this.s.ready()) return null;
    const site = this.s.site();
    const stats = this.s.stats();
    const aim = this.s.aim();
    if (!site || !stats?.sun || !stats?.earth || !Number.isFinite(stats.sun[aim]) || !Number.isFinite(stats.earth[aim])) return null;
    return {
      site: site.M.site.name,
      days: (this.s.win().n - 1) * site.STEP_MS / 86400000,
      sun: Number(stats.sun[aim]).toFixed(1),
      earth: Number(stats.earth[aim]).toFixed(1),
    };
  });

  protected readonly steps = [
    { n: '01', title: 'Choose a site', text: 'Start with a curated south-pole area, or enter coordinates inside the covered terrain.', frag: 'sites' },
    { n: '02', title: 'Set the mission window', text: 'Choose landing time and duration. Watch Sun and Earth move above the real horizon.', frag: 'mission' },
    { n: '03', title: 'Spread the landing', text: 'Set the drift you can tolerate. See which nearby touchdown spots still meet your profile.', frag: 'landing' },
    { n: '04', title: 'Compare the decision', text: 'Put sites or dates side by side, find the flip point, and export the result.', frag: 'compare' },
  ];

  /** Illustrative landing scatter for the problem section; never presented as engine output. */
  protected readonly dots: Dot[] = (() => {
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const out: Dot[] = [];
    while (out.length < 46) {
      const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 78, x = 100 + r * Math.cos(a), y = 100 + r * Math.sin(a);
      const inCrater = (x - 140) ** 2 / 34 ** 2 + (y - 128) ** 2 / 26 ** 2 < 1;
      const inShadow = x < 52 && y < 92;
      out.push({ x, y, ok: !(inCrater || inShadow), delay: out.length * 0.11 });
    }
    return out;
  })();

  private readonly onScroll = () => {
    const el = this.host.nativeElement as HTMLElement;
    el.style.setProperty('--sy', String(Math.min(scrollY, 1600)));
    const max = document.documentElement.scrollHeight - innerHeight;
    el.style.setProperty('--progress', String(max > 0 ? scrollY / max : 0));
  };
  private readonly onMove = (e: PointerEvent) => {
    const el = this.host.nativeElement as HTMLElement;
    el.style.setProperty('--mx', (e.clientX / innerWidth - 0.5).toFixed(3));
    el.style.setProperty('--my', (e.clientY / innerHeight - 0.5).toFixed(3));
  };

  ngOnInit() {
    if (this.reduce) return;
    this.zone.runOutsideAngular(() => {
      addEventListener('scroll', this.onScroll, { passive: true });
      addEventListener('pointermove', this.onMove, { passive: true });
      this.onScroll();
    });
  }
  ngOnDestroy() {
    removeEventListener('scroll', this.onScroll);
    removeEventListener('pointermove', this.onMove);
  }

  askCopilot(event: Event, question: string) {
    event.preventDefault();
    // Copilot is not wired to the frontend yet; take the visitor to the planner.
    // Keep the submitted question out of the URL until the API integration exists.
    if (!question.trim()) return;
    this.router.navigate(['/mission'], {
      queryParams: { mode: 'explore' },
      fragment: 'mission',
    });
  }

  planAt(id: string) {
    this.s.selectSite(id);
    this.router.navigate(['/planner'], { fragment: 'mission' });
  }
}
