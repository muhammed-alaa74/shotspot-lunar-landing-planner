import { DecimalPipe } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';
import {
  SiteData,
  eph,
  hzAt,
  idxTime,
  iso,
  nextChange,
  runs,
  visSeries,
} from '../../core/engine';

const DAY_MS = 86400000;
const PLOT_SIZE = 500;
const PLOT_CENTER = PLOT_SIZE / 2;
const PLOT_RADIUS = 190;
const MAX_TRACK_POINTS = 360;

type BodyKey = 'sun' | 'earth';

interface Point {
  x: number;
  y: number;
  azimuth: number;
  elevation: number;
}

interface BodyTrack {
  segments: string[];
  outside: boolean;
  current: Point | null;
  currentOutside: boolean;
  elevation: number;
  visible: boolean;
  horizon: number;
}

interface BodyBand {
  segments: BandSegment[];
  visiblePercent: number;
}

interface BandSegment {
  left: number;
  width: number;
  visible: boolean;
}

interface TimelineDay {
  label: string;
  left: number;
  width: number;
  partial: boolean;
  sun: BodyBand;
  earth: BodyBand;
}

interface SkyState {
  ready: boolean;
  d: SiteData | null;
  start: number;
  count: number;
  cursor: number;
  horizon: string;
  sun: BodyTrack;
  earth: BodyTrack;
  timeline: TimelineDay[];
  cursorTime: string;
  windowText: string;
  rangeNote: string;
}

function finiteInt(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function polarPoint(azimuth: number, elevation: number): Point {
  const radius = ((90 - elevation) / 90) * PLOT_RADIUS;
  const radians = (azimuth * Math.PI) / 180;
  return {
    x: PLOT_CENTER + radius * Math.sin(radians),
    y: PLOT_CENTER - radius * Math.cos(radians),
    azimuth,
    elevation,
  };
}

function inPlotRange(elevation: number) {
  return Number.isFinite(elevation) && elevation >= 0 && elevation <= 90;
}

function pointString(point: Point) {
  return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
}

function sampledIndices(length: number) {
  if (length <= MAX_TRACK_POINTS) return Array.from({ length }, (_, index) => index);
  return Array.from({ length: MAX_TRACK_POINTS }, (_, index) =>
    Math.round((index * (length - 1)) / (MAX_TRACK_POINTS - 1)),
  );
}

function formatDuration(ms: number | null) {
  if (ms === null || !Number.isFinite(ms)) return 'Not within this window';
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function bandFor(
  visibility: Uint8Array,
  startIndex: number,
  endIndex: number,
  dayStartMs: number,
  totalMs: number,
  stepMs: number,
): BodyBand {
  const intervalCount = Math.max(0, endIndex - startIndex);
  if (intervalCount === 0) {
    const visible = visibility[Math.min(startIndex, visibility.length - 1)] === 1;
    return { segments: [{ left: 0, width: 100, visible }], visiblePercent: visible ? 100 : 0 };
  }

  const sample = visibility.slice(startIndex, endIndex);
  const segmentRuns = runs(sample);
  const segments = segmentRuns.map(([runStart, runEnd]) => {
    const from = startIndex + runStart;
    const to = startIndex + runEnd;
    const left = clamp(((from * stepMs - dayStartMs) / totalMs) * 100, 0, 100);
    const right = clamp(((to * stepMs - dayStartMs) / totalMs) * 100, left, 100);
    return { left, width: Math.max(right - left, 0.25), visible: sample[runStart] === 1 };
  });

  const visiblePercent = Math.round((sample.reduce((sum, value) => sum + value, 0) / sample.length) * 100);
  return { segments, visiblePercent };
}

function buildTimeline(sun: Uint8Array, earth: Uint8Array, stepMs: number): TimelineDay[] {
  const sampleIntervals = Math.max(0, sun.length - 1);
  const totalMs = Math.max(stepMs, sampleIntervals * stepMs);
  const dayCount = Math.max(1, Math.ceil(totalMs / DAY_MS));
  const days: TimelineDay[] = [];

  for (let day = 0; day < dayCount; day++) {
    const dayStartMs = day * DAY_MS;
    const dayEndMs = Math.min(totalMs, (day + 1) * DAY_MS);
    const from = Math.min(sampleIntervals, Math.floor(dayStartMs / stepMs));
    const to = Math.min(sampleIntervals, Math.max(from + 1, Math.ceil(dayEndMs / stepMs)));
    const left = (dayStartMs / totalMs) * 100;
    const width = ((dayEndMs - dayStartMs) / totalMs) * 100;
    days.push({
      label: `D${day + 1}`,
      left,
      width,
      partial: dayEndMs - dayStartMs < DAY_MS,
      sun: bandFor(sun, from, to, dayStartMs, totalMs, stepMs),
      earth: bandFor(earth, from, to, dayStartMs, totalMs, stepMs),
    });
  }
  return days;
}

@Component({
  selector: 'app-sky-overview',
  standalone: true,
  imports: [DecimalPipe],
  templateUrl: './sky-overview.html',
  styleUrl: './sky-overview.css',
})
export class SkyOverview {
  readonly data = input.required<SiteData>();
  readonly aim = input.required<number>();
  readonly s0 = input.required<number>();
  readonly n = input.required<number>();

  private readonly cursor = signal(0);

  protected readonly state = computed<SkyState>(() => {
    const d = this.data();
    const rawStart = finiteInt(this.s0(), 0);
    const rawCount = finiteInt(this.n(), 0);
    const maxSamples = Math.floor((d?.EPH?.length ?? 0) / 4);
    const start = clamp(rawStart, 0, Math.max(0, maxSamples));
    const count = Math.min(Math.max(0, rawCount), Math.max(0, maxSamples - start));
    const k = finiteInt(this.aim(), -1);
    const hasTerrain = !!d?.HZ && k >= 0 && k < (d?.N ?? 0) && d.HZ.length >= (k + 1) * 360;
    const ready = !!d && !!d.EPH && hasTerrain && count > 0;

    if (!ready) {
      return {
        ready: false,
        d: d ?? null,
        start,
        count,
        cursor: 0,
        horizon: '',
        sun: this.emptyBody(),
        earth: this.emptyBody(),
        timeline: [],
        cursorTime: '',
        windowText: count === 0 ? 'No ephemeris samples are available for this window.' : 'Preparing sky data…',
        rangeNote: '',
      };
    }

    const safeCursor = clamp(this.cursor(), 0, count - 1);
    const visibility = visSeries(d, k, start, count);
    const horizon = this.horizonPoints(d, k);
    const sun = this.track(d, start, count, safeCursor, 0, 1, visibility.sun, k);
    const earth = this.track(d, start, count, safeCursor, 2, 3, visibility.ear, k);
    const out = [sun.outside, earth.outside].filter(Boolean);
    const rangeNote = out.length
      ? `${out.map((_, index) => (index === 0 && sun.outside ? 'Sun' : 'Earth')).join(' and ')} track${out.length > 1 ? 's' : ''} omit samples outside the 0°–90° polar plotting range.`
      : 'Tracks show the selected window, downsampled to at most 360 plotted samples; visibility uses every sample.';

    return {
      ready: true,
      d,
      start,
      count,
      cursor: safeCursor,
      horizon,
      sun,
      earth,
      timeline: buildTimeline(visibility.sun, visibility.ear, d.STEP_MS),
      cursorTime: iso(idxTime(d, start + safeCursor)),
      windowText: `${iso(idxTime(d, start))} → ${iso(idxTime(d, start + count - 1))}`,
      rangeNote,
    };
  });

  protected readonly counters = computed(() => {
    const view = this.state();
    if (!view.ready || !view.d) return [];
    const d = view.d;
    const k = finiteInt(this.aim(), -1);
    const visibility = visSeries(d, k, view.start, view.count);
    return (['sun', 'earth'] as const).map((body) => {
      const values = body === 'sun' ? visibility.sun : visibility.ear;
      const visible = values[view.cursor] === 1;
      const change = nextChange(d, k, body, visibility, view.cursor, view.start, view.count);
      const name = body === 'sun' ? 'Sun' : 'Earth';
      const event = visible ? (body === 'sun' ? 'sunset' : 'Earthset') : body === 'sun' ? 'sunrise' : 'Earthrise';
      return {
        body,
        name,
        visible,
        label: `${event} in`,
        value: formatDuration(change?.ms ?? null),
      };
    });
  });

  protected readonly legend = [
    { className: 'sun', label: 'Sun' },
    { className: 'earth', label: 'Earth' },
    { className: 'horizon', label: 'Terrain horizon' },
  ];

  protected setCursor(event: Event) {
    const value = +(event.target as HTMLInputElement).value;
    if (Number.isFinite(value)) this.cursor.set(value);
  }
  protected readonly dayLabelStep = computed(() => Math.max(1, Math.ceil(this.state().timeline.length / 10)));

  protected bodyBand(day: TimelineDay, body: BodyKey) {
    return day[body];
  }

  protected polarLabel(azimuth: number, radius: number) {
    const radians = (azimuth * Math.PI) / 180;
    return {
      x: PLOT_CENTER + radius * Math.sin(radians),
      y: PLOT_CENTER - radius * Math.cos(radians),
    };
  }

  private emptyBody(): BodyTrack {
    return { segments: [], outside: false, current: null, currentOutside: true, elevation: NaN, visible: false, horizon: NaN };
  }

  private horizonPoints(d: SiteData, k: number) {
    const points: string[] = [];
    for (let azimuth = 0; azimuth <= 360; azimuth++) {
      const elevation = hzAt(d, k, azimuth % 360);
      points.push(pointString(polarPoint(azimuth, elevation)));
    }
    return points.join(' ');
  }

  private track(
    d: SiteData,
    start: number,
    count: number,
    cursor: number,
    azimuthIndex: 0 | 2,
    elevationIndex: 1 | 3,
    visibility: Uint8Array,
    k: number,
  ): BodyTrack {
    const points = sampledIndices(count);
    const segments: string[] = [];
    let currentSegment: string[] = [];
    let outside = false;
    for (let relativeIndex = 0; relativeIndex < count; relativeIndex++) {
      const e = eph(d, start + relativeIndex);
      const elevation = elevationIndex === 1 ? e.se : e.ee;
      if (!inPlotRange(elevation)) outside = true;
    }
    for (const relativeIndex of points) {
      const e = eph(d, start + relativeIndex);
      const elevation = elevationIndex === 1 ? e.se : e.ee;
      const azimuth = azimuthIndex === 0 ? e.sa : e.ea;
      if (!inPlotRange(elevation)) {
        if (currentSegment.length > 1) segments.push(currentSegment.join(' '));
        currentSegment = [];
        continue;
      }
      currentSegment.push(pointString(polarPoint(azimuth, elevation)));
    }
    if (currentSegment.length > 1) segments.push(currentSegment.join(' '));

    const currentEphemeris = eph(d, start + cursor);
    const currentElevation = elevationIndex === 1 ? currentEphemeris.se : currentEphemeris.ee;
    const currentAzimuth = azimuthIndex === 0 ? currentEphemeris.sa : currentEphemeris.ea;
    const horizon = hzAt(d, k, currentAzimuth);
    return {
      segments,
      outside,
      current: inPlotRange(currentElevation) ? polarPoint(currentAzimuth, currentElevation) : null,
      currentOutside: !inPlotRange(currentElevation),
      elevation: currentElevation,
      visible: visibility[cursor] === 1,
      horizon,
    };
  }
}
