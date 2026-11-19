import { AfterViewInit, Component, DestroyRef, ElementRef, NgZone, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Store } from './core/store';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements AfterViewInit {
  protected readonly s = inject(Store);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private readonly destroy = inject(DestroyRef);
  @ViewChild('topbar', { static: true }) private topbar!: ElementRef<HTMLElement>;
  protected readonly url = signal(this.router.url);
  protected readonly planner = computed(() => this.url().startsWith('/planner') || this.url().startsWith('/plan/'));
  private frame = 0;
  private resize?: ResizeObserver;

  constructor() {
    this.s.init();
    effect(() => document.body.classList.toggle('simple', this.s.simple()));
    // The router already restores positions and handles fragments; do not scroll twice.
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.url.set(event.urlAfterRedirects);
    });
    this.destroy.onDestroy(() => subscription.unsubscribe());
  }

  ngAfterViewInit() {
    const header = this.topbar.nativeElement;
    const root = document.documentElement;
    const previousHeight = root.style.getPropertyValue('--topbar-h');
    const measure = () => {
      const height = `${Math.ceil(header.getBoundingClientRect().height)}px`;
      if (root.style.getPropertyValue('--topbar-h') !== height) root.style.setProperty('--topbar-h', height);
    };
    const scroll = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        header.classList.toggle('is-scrolled', window.scrollY > 16);
        this.frame = 0;
      });
    };
    this.zone.runOutsideAngular(() => {
      measure();
      if ('ResizeObserver' in window) {
        this.resize = new ResizeObserver(measure);
        this.resize.observe(header);
      }
      window.addEventListener('resize', measure, { passive: true });
      window.addEventListener('scroll', scroll, { passive: true });
      scroll();
    });
    this.destroy.onDestroy(() => {
      this.resize?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', scroll);
      cancelAnimationFrame(this.frame);
      if (previousHeight) root.style.setProperty('--topbar-h', previousHeight);
      else root.style.removeProperty('--topbar-h');
    });
  }

  protected goHome(event: MouseEvent) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (this.router.url.split(/[?#]/)[0] !== '/') return;
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  print() { window.print(); }
}
