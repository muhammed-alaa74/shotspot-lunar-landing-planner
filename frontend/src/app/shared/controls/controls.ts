import { Component, inject, signal } from '@angular/core';
import { Store } from '../../core/store';
import { Profile } from '../../core/engine';

@Component({
  selector: 'app-controls',
  templateUrl: './controls.html',
})
export class Controls {
  protected readonly s = inject(Store);
  protected readonly mobileOpen = signal(false);
  protected toggleMobileSettings() { this.mobileOpen.update(open => !open); }
  protected readonly fields: { key: keyof Profile; label: string; max?: number; step: number }[] = [
    { key: 'minSun', label: 'Min sunlight (%)', max: 100, step: 1 },
    { key: 'minEarth', label: 'Min Earth visibility (%)', max: 100, step: 1 },
    { key: 'maxSunGap', label: 'Max dark period (h)', step: 1 },
    { key: 'maxEarthGap', label: 'Max Earth outage (h)', step: 1 },
    { key: 'maxSlope', label: 'Max slope (°)', max: 45, step: 0.5 },
  ];
  num(e: Event) { return +(e.target as HTMLInputElement).value; }
  val(e: Event) { return (e.target as HTMLInputElement).value; }
  setField(key: keyof Profile, e: Event) { const v = this.num(e); if (Number.isFinite(v)) this.s.setProfile({ [key]: v } as Partial<Profile>); }
  checked(e: Event) { return (e.target as HTMLInputElement).checked; }
  profileValue(key: keyof Profile) { return this.s.profile()[key] as number; }
}
