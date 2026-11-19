import { AfterViewInit, Component, ElementRef, OnDestroy, effect, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Store } from '../../core/store';
import { goSection } from '../../core/nav';
import { Controls } from '../../shared/controls/controls';
import { Sites } from '../sites/sites';
import { Mission } from '../mission/mission';
import { Landing } from '../landing/landing';
import { Compare } from '../compare/compare';

/** The whole technical tool on one page: controls on the left, four sections on the right. */
@Component({
  selector: 'app-planner',
  imports: [Controls, Sites, Mission, Landing, Compare],
  styleUrl: './planner.css',
  template: `
@if (s.error(); as err) {
    <div class="card load-error" role="alert"><h2 class="card-title" style="color: var(--c-fail)">Failed to load site data</h2>
      <p class="explain">{{ err }}</p><p class="hint">Run the app with <code>npm start</code> inside frontend/ (it serves web/data) and reload.</p></div>
  } @else if (!s.ready()) {
    <div class="loading" role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div><p>Loading precomputed site data…</p></div>
  } @else {
    <main class="app">
      <app-controls />
      <div class="content">
        <nav class="sec-tabs" aria-label="Planner sections">
          @for (t of tabs; track t.id; let i = $index) {
            <button class="sec-tab" [class.active]="active() === t.id" [attr.aria-current]="active() === t.id ? 'true' : null" (click)="go(t.id)">
              <b>{{ i + 1 }}</b>{{ t.label }}</button>
          }
        </nav>
        <section id="sites" class="sec"><app-sites /></section>
        <section id="mission" class="sec"><app-mission /></section>
        <section id="landing" class="sec"><app-landing /></section>
        <section id="compare" class="sec"><app-compare /></section>
      </div>
    </main>
  }`,
})
export class Planner implements AfterViewInit, OnDestroy {
  protected readonly s = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly tabs = [
    { id: 'sites', label: 'Site' }, { id: 'mission', label: 'Mission & sky' },
    { id: 'landing', label: 'Landing accuracy' }, { id: 'compare', label: 'Compare' },
  ];
  protected readonly active = signal('sites');
  private io?: IntersectionObserver;
  private viewReady = signal(false);

  constructor() {
    // once the data is in and the sections exist: watch them (scroll-spy) and honour a #fragment
    effect(() => {
      if (!this.s.ready() || !this.viewReady()) return;
      setTimeout(() => {
        this.io?.disconnect();
        const header = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 88;
        const top = Math.min(header + 72, Math.max(0, window.innerHeight - 120));
        const bottom = Math.max(0, window.innerHeight - top - 120);
        const sections = [...(this.host.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('section.sec')];
        this.io = new IntersectionObserver(() => {
          let current = sections[0];
          for (const section of sections) if (section.getBoundingClientRect().top <= top + 60) current = section;
          if (current) this.active.set(current.id);
        }, { rootMargin: `-${top}px 0px -${bottom}px 0px` });
        sections.forEach(el => this.io!.observe(el));
        const f = this.route.snapshot.fragment;
        if (f) goSection(f);
      });
    });
  }
  ngAfterViewInit() { this.viewReady.set(true); }
  ngOnDestroy() { this.io?.disconnect(); }
  go(id: string) { this.active.set(id); goSection(id); }
}
