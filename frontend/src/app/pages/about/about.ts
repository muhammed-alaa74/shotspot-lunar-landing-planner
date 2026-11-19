import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '../../core/store';

@Component({
  selector: 'app-about',
  imports: [RouterLink],
  template: `
  <div class="page page--narrow">
    <h1 class="page-title">Assumptions & limits</h1>
    <p class="page-lead">What SHOTSPOT computes, where the data comes from, how it was checked, and what it does not claim.</p>
    @if (!s.ready()) {
      @if (s.error(); as err) { <div class="card load-error" role="alert"><h2 class="card-title" style="color: var(--c-fail)">Failed to load site data</h2><p class="explain">{{ err }}</p></div> }
      @if (!s.error()) { <div class="loading" role="status"><div class="spinner" aria-hidden="true"></div><p>Loading…</p></div> }
    } @else {
      @let M = s.site().M;
      <div class="card"><h2 class="card-title">Assumptions</h2>
        <ul class="list">@for (a of M.assumptions; track a) { <li>{{ a }}</li> }
          <li><b>Prototype data:</b> the demo aim points are our choice, and custom coordinates only work inside the precomputed ±1.2 km area of each site.</li></ul></div>
      <div class="card card--gap"><h2 class="card-title">What the tool does not claim</h2>
        <ul class="list"><li>Power generated (only solar visibility).</li><li>Link quality (only geometric Earth visibility).</li>
          <li>Hazards smaller than the grid (~10 m rocks and craters).</li><li>A predicted landing error (drift is your input).</li></ul></div>
      <div class="card card--gap"><h2 class="card-title">Data sources & resolution</h2>
        <ul class="list">@for (a of M.sources; track a) { <li>{{ a }}</li> }
          <li>Resolution: terrain {{ M.hillshade.res }} m/px near field, 120 m/px far field out to {{ M.horizon.max_distance_km }} km; landing spots every {{ M.spots.spacing_m }} m; Sun/Earth every {{ M.ephem.step_min }} min (UTC).</li></ul></div>
      <div class="card card--gap"><h2 class="card-title">Validation <small>· {{ s.site().entry.name }}</small></h2>
        <ul class="list">
          @for (b of bodies(); track b.name) { <li>{{ b.name }}: {{ b.n }} sample times vs NASA JPL Horizons, max |Δaz| {{ b.daz }}°, max |Δel| {{ b.del }}°</li> }
          <li>Horizon engine: unit tests on synthetic terrain (flat sphere, 100 m wall at 4 km).</li>
          <li><b>Pending:</b> comparison of at least 2 site-date cases with NASA Quickmap / Moon Trek is not documented yet.</li>
        </ul></div>
      <div class="card card--gap"><h2 class="card-title">Glossary</h2>
        <dl class="gloss">
          <dt>Horizon</dt><dd>The skyline made by the surrounding terrain, as seen from a spot.</dd>
          <dt>Elevation</dt><dd>Angle above flat ground, in degrees. Negative means below it.</dd>
          <dt>Azimuth</dt><dd>Compass direction: 0° north, 90° east.</dd>
          <dt>Drift radius</dt><dd>How far from the aim point the lander may touch down.</dd>
          <dt>First decision crossover</dt><dd>The first sampled change from the 25 m reference choice, checked in 25 m steps up to 500 m. Rankings can change again at larger radii; this is not a permanent winner.</dd>
          <dt>Weakly constrained terrain</dt><dd>No real laser measurement within 20 m; heights are interpolated.</dd>
        </dl></div>
      <p class="step-nav"><a class="btn btn--primary" routerLink="/planner">Start planning →</a></p>
    }
  </div>`,
  styles: [`.list { padding-inline-start: 1.2em; display: grid; gap: var(--sp-2); color: var(--c-text-2); margin-block-start: var(--sp-3); }
    .gloss { display: grid; grid-template-columns: max-content 1fr; gap: var(--sp-2) var(--sp-4); margin-block-start: var(--sp-3); }
    .gloss dt { font-weight: 600; } .gloss dd { margin: 0; color: var(--c-text-2); }
    @media (max-width: 600px) { .gloss { grid-template-columns: 1fr; } .gloss dd { margin-block-end: var(--sp-2); } }`],
})
export class About {
  protected readonly s = inject(Store);
  protected readonly bodies = computed(() => Object.entries<any>(this.s.site()?.M.validation_vs_jpl_horizons ?? {})
    .map(([name, x]) => ({ name, n: x.n, daz: x.max_abs_daz_deg.toFixed(4), del: x.max_abs_del_deg.toFixed(4) })));
}
