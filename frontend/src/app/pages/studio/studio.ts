import { Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Demo } from '../demo/demo';
import { Planner } from '../planner/planner';
import { Store } from '../../core/store';
import { goSection } from '../../core/nav';
import { idxTime } from '../../core/engine';

@Component({
  selector: 'app-studio',
  imports: [Demo, Planner, RouterLink],
  templateUrl: './studio.html',
  styleUrl: './studio.css',
})
export class Studio {
  protected readonly s = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  protected readonly mode = signal<'guided' | 'explore'>('guided');
  protected readonly continued = signal(false);

  constructor() {
    const sub = this.route.queryParamMap.subscribe((params) => {
      this.mode.set(params.get('mode') === 'explore' ? 'explore' : 'guided');
    });
    this.destroy.onDestroy(() => sub.unsubscribe());
  }

  protected setMode(mode: 'guided' | 'explore') {
    if (mode === this.mode()) return;
    this.continued.set(false);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: mode === 'explore' ? { mode: 'explore' } : {},
    });
  }

  protected edit(section: string) { goSection(section); }
  protected landingDate() {
    return new Date(idxTime(this.s.site(), this.s.win().s0)).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
  }
  protected windowDays() { return (this.s.win().n - 1) * this.s.site().STEP_MS / 86400000; }
  protected fromDemo(section: 'sites' | 'mission' | 'landing' = 'landing') {
    this.continued.set(true);
    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { mode: 'explore' },
      fragment: section,
    });
  }
}
