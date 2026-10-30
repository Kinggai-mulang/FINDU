import type { Epoch, ResultSet, RealtimeMetrics } from '../contracts';
import { arEnabled } from './domain';

export const resultGroupKey = (r: Pick<ResultSet, 'source' | 'station'>) => `${r.source}:${r.station}`;
export type Cohort = 'own' | 'common' | 'fixed' | 'common-fixed';
export type Motion = 'unknown' | 'static' | 'dynamic';
export interface Window {
  start?: number;
  end?: number;
}
export const fixed = (e: Epoch) => e.solution === 'FIX' || e.solution === 'HOLD';
export const carrier = (e: Epoch) => ['FLOAT', 'FLOFIX', 'FIX', 'HOLD'].includes(e.solution);
export const keyOf = (e: Epoch) =>
  Math.round(e.gpsWeek !== undefined && e.tow !== undefined ? (e.gpsWeek * 604800 + e.tow) * 1000 : Date.parse(e.time));
export const metricKey = (m: RealtimeMetrics) =>
  typeof m.Week === 'number' && typeof m.TOW === 'number'
    ? Math.round((m.Week * 604800 + m.TOW) * 1000)
    : Date.parse(m.time);
export const within = (time: string | number, w: Window) => {
  const t = typeof time === 'number' ? time : Date.parse(time);
  return Number.isFinite(t) && (w.start === undefined || t >= w.start) && (w.end === undefined || t <= w.end);
};
const windowTimes = new WeakMap<object[], number[]>();
/** Rows inside a UTC window. Times are parsed once per array, and an unfiltered window keeps the array identity
 * so downstream memos (thinning, charts) stay valid. */
export function inWindow<T extends { time: string }>(rows: T[], w: Window): T[] {
  if (w.start === undefined && w.end === undefined) return rows;
  let times = windowTimes.get(rows);
  if (!times) windowTimes.set(rows, (times = rows.map((r) => Date.parse(r.time))));
  const t = times;
  const kept = rows.filter((_, i) => within(t[i], w));
  return kept.length === rows.length ? rows : kept;
}
const keyCache = new WeakMap<object[], Float64Array>();
function keysOf<T extends object>(rows: T[], key: (row: T) => number) {
  let keys = keyCache.get(rows);
  if (!keys) {
    keys = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) keys[i] = key(rows[i]);
    keyCache.set(rows, keys);
  }
  return keys;
}
/** `keyOf` of every epoch, computed once per array; an analysis walks the same epochs several times. */
export const epochKeys = (epochs: Epoch[]) => keysOf(epochs, keyOf);
/** `metricKey` of every diagnostics row, computed once per array. */
export const rowKeys = (rows: RealtimeMetrics[]) => keysOf(rows, metricKey);

export const median = (v: ArrayLike<number>) => quantile(v, 0.5);
/** Linear-interpolated quantile, the value a full sort would give. */
export function quantile(v: ArrayLike<number>, p: number): number | null {
  if (!v.length) return null;
  const a = Float64Array.from(v),
    i = (a.length - 1) * p,
    k = Math.floor(i);
  if (a.some(Number.isNaN)) {
    a.sort();
    return a[k] + (a[Math.min(k + 1, a.length - 1)] - a[k]) * (i - k);
  }
  // Selection instead of sorting: two order statistics in linear time, for the medians and 95th percentiles of
  // 170 000-epoch results.
  const low = select(a, k);
  let high = low;
  if (k + 1 < a.length) {
    high = a[k + 1];
    for (let j = k + 2; j < a.length; j++) if (a[j] < high) high = a[j];
  }
  return low + (high - low) * (i - k);
}
/** Hoare quickselect: puts the k-th smallest value at `a[k]`, smaller ones before it and larger ones after it. */
function select(a: Float64Array, k: number) {
  let lo = 0,
    hi = a.length - 1;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo,
      j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const t = a[i];
        a[i++] = a[j];
        a[j--] = t;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}
export function summarize(values: number[]) {
  const magnitudes = new Float64Array(values.length);
  let n = 0,
    sum = 0,
    squares = 0,
    max = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    magnitudes[n++] = Math.abs(v);
    sum += v;
    squares += v * v;
    max = Math.max(max, Math.abs(v));
  }
  if (!n) return { n: 0, mean: null, rms: null, std: null, p95: null, max: null };
  const mean = sum / n;
  let deviation = 0;
  for (const v of values) if (Number.isFinite(v)) deviation += (v - mean) ** 2;
  return {
    n,
    mean,
    rms: Math.sqrt(squares / n),
    std: Math.sqrt(deviation / n),
    p95: quantile(magnitudes.subarray(0, n), 0.95),
    max,
  };
}
export function validReference(text: string): [number, number, number] | null {
  const a = text
    .trim()
    .split(/[,，\s]+/)
    .filter(Boolean)
    .map(Number);
  return a.length === 3 && a.every(Number.isFinite) && Math.hypot(...a) > 1e6 ? (a as [number, number, number]) : null;
}
// Rotation of the last origin; analyses project every epoch onto one origin, so the geodetic latitude
// iteration runs once per origin instead of once per epoch.
let frame: { x: number; y: number; z: number; sLat: number; cLat: number; sLon: number; cLon: number } | undefined;
function rotation(origin: number[]) {
  const [x, y, z] = origin;
  if (frame && frame.x === x && frame.y === y && frame.z === z) return frame;
  const lon = Math.atan2(y, x),
    p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - 0.00669437999014));
  for (let i = 0; i < 10; i++) {
    const r = 6378137 / Math.sqrt(1 - 0.00669437999014 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + 0.00669437999014 * r * Math.sin(lat), p);
  }
  frame = { x, y, z, sLat: Math.sin(lat), cLat: Math.cos(lat), sLon: Math.sin(lon), cLon: Math.cos(lon) };
  return frame;
}
export function enu(xyz: number[], origin: number[]): [number, number, number] {
  const { sLat, cLat, sLon, cLon } = rotation(origin);
  const dx = xyz[0] - origin[0],
    dy = xyz[1] - origin[1],
    dz = xyz[2] - origin[2];
  return [
    -sLon * dx + cLon * dy,
    -sLat * cLon * dx - sLat * sLon * dy + cLat * dz,
    cLat * cLon * dx + cLat * sLon * dy + sLat * dz,
  ];
}
export function sharedResults(
  results: ResultSet[],
  baselineId: string,
  reference: [number, number, number] | null,
): ResultSet[] {
  const base = results.find((r) => r.id === baselineId) ?? results[0];
  const origin =
    reference ??
    base?.referenceXyz ??
    results.find((r) => r.referenceXyz)?.referenceXyz ??
    (base?.epochs[0] && [base.epochs[0].x, base.epochs[0].y, base.epochs[0].z].every((v) => typeof v === 'number')
      ? [base.epochs[0].x!, base.epochs[0].y!, base.epochs[0].z!]
      : null);
  return results.map((r) => ({
    ...r,
    referenceXyz: origin ?? r.referenceXyz,
    epochs: r.epochs.map((e) =>
      origin && [e.x, e.y, e.z].every((v) => typeof v === 'number' && Number.isFinite(v))
        ? {
            ...e,
            ...(() => {
              const [east, north, up] = enu([e.x!, e.y!, e.z!], origin);
              return { e: east, n: north, u: up };
            })(),
          }
        : e,
    ),
  }));
}
/** Median positive spacing in seconds of ascending keys. */
function medianStep(keys: Float64Array): number | null {
  const steps: number[] = [];
  for (let i = 1; i < keys.length; i++) {
    const step = (keys[i] - keys[i - 1]) / 1000;
    if (step > 0) steps.push(step);
  }
  return median(steps);
}
export function estimateInterval(epochs: Epoch[]): number {
  return medianStep(epochKeys(epochs)) ?? 1;
}
export interface Event {
  id: string;
  time: string;
  kind: string;
  detail: string;
  value?: number;
  endTime?: string;
}
export function continuity(epochs: Epoch[], motion: Motion, interval = estimateInterval(epochs)) {
  const events: Event[] = [];
  const steps: { time: string; value: number }[] = [];
  let gaps = 0,
    switches = 0;
  const segments: { start: string; end: string; n: number; seconds: number }[] = [];
  let segment: (typeof segments)[number] | undefined;
  let segmentKey = 0;
  const keys = epochKeys(epochs);
  for (let i = 0; i < epochs.length; i++) {
    const e = epochs[i],
      prev = epochs[i - 1],
      dt = prev ? (keys[i] - keys[i - 1]) / 1000 : 0;
    const contiguous = !!prev && dt > 0 && dt <= interval * 1.5;
    if (prev && dt > interval * 1.5) {
      gaps++;
      events.push({
        id: `gap-${i}`,
        time: prev.time,
        endTime: e.time,
        kind: '输出缺口',
        detail: `连续有效定位间隔 ${dt.toFixed(3)} s`,
        value: dt,
      });
    }
    if (contiguous && prev.solution !== e.solution && !(fixed(prev) && fixed(e))) {
      switches++;
      events.push({ id: `state-${i}`, time: e.time, kind: '解状态变化', detail: `${prev.solution} → ${e.solution}` });
    }
    if (contiguous && carrier(e) && carrier(prev)) {
      const value = Math.hypot(e.e - prev.e, e.n - prev.n, e.u - prev.u);
      steps.push({ time: e.time, value });
    }
    if (fixed(e)) {
      if (segment && contiguous) {
        segment.end = e.time;
        segment.n++;
        segment.seconds = (keys[i] - segmentKey) / 1000;
      } else {
        segment = { start: e.time, end: e.time, n: 1, seconds: 0 };
        segmentKey = keys[i];
        segments.push(segment);
      }
    } else segment = undefined;
  }
  // The ten largest steps in the order a stable descending sort gives, without sorting every step.
  const largest: typeof steps = [];
  for (const s of steps) {
    if (largest.length === 10 && s.value <= largest[9].value) continue;
    let at = largest.length;
    while (at > 0 && largest[at - 1].value < s.value) at--;
    largest.splice(at, 0, s);
    if (largest.length > 10) largest.pop();
  }
  for (const s of largest)
    events.push({
      id: `step-${s.time}`,
      time: s.time,
      kind: motion === 'static' ? '位置步差核查' : '相邻位置步差',
      detail: motion === 'static' ? '连续载波解历元的位置变化，需结合诊断核查' : '可能包含真实运动，不能直接判为异常',
      value: s.value,
    });
  return {
    gaps,
    switches,
    interval,
    segments,
    steps,
    maxStep: steps.length ? steps.reduce((a, s) => Math.max(a, s.value), 0) : null,
    events,
  };
}
export function convergence(
  epochs: Epoch[],
  reference: boolean,
  horizontal: number | undefined,
  vertical: number | undefined,
  hold: number | undefined,
  interval: number,
): string | null {
  if (!reference || !horizontal || !vertical || hold === undefined || hold <= 0) return null;
  const keys = epochKeys(epochs);
  let start: number | undefined;
  for (let i = 0; i < epochs.length; i++) {
    const e = epochs[i];
    if (
      !carrier(e) ||
      Math.hypot(e.e, e.n) > horizontal ||
      Math.abs(e.u) > vertical ||
      (i > 0 && (keys[i] - keys[i - 1]) / 1000 > interval * 1.5)
    ) {
      start = undefined;
    }
    if (carrier(e) && Math.hypot(e.e, e.n) <= horizontal && Math.abs(e.u) <= vertical) {
      start ??= i;
      if ((keys[i] - keys[start]) / 1000 >= hold) return epochs[start].time;
    }
  }
  return null;
}
// Zooming changes only the window; the reprojection of every epoch is reused until the inputs change.
let sharedCache: { inputs: unknown[]; full: ResultSet[] } | undefined;
function cachedShared(results: ResultSet[], baselineId: string, reference: [number, number, number] | null) {
  const inputs = [baselineId, reference?.join(','), ...results];
  if (sharedCache && sharedCache.inputs.length === inputs.length && sharedCache.inputs.every((v, i) => v === inputs[i]))
    return sharedCache.full;
  sharedCache = { inputs, full: sharedResults(results, baselineId, reference) };
  return sharedCache.full;
}
export function buildAnalysis(
  results: ResultSet[],
  options: {
    window: Window;
    cohort: Cohort;
    baselineId: string;
    reference: [number, number, number] | null;
    motion: Motion;
    horizontal?: number;
    vertical?: number;
    hold?: number;
  },
) {
  const full = cachedShared(results, options.baselineId, options.reference);
  const extent = ['e', 'n', 'u'].map((k) => {
    let lo = Infinity,
      hi = -Infinity;
    for (const r of full)
      for (const e of r.epochs) {
        const v = e[k as 'e' | 'n' | 'u'];
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    const pad = Math.max((hi - lo) * 0.06, 0.001);
    return Number.isFinite(lo) ? [lo - pad, hi + pad] : [-1, 1];
  });
  const projected = full.map((r) => ({
    ...r,
    epochs: inWindow(r.epochs, options.window),
    diagnostics: inWindow(r.diagnostics ?? [], options.window),
  }));
  const sets = projected.map((r) => {
    const keys = epochKeys(r.epochs);
    const set = new Set<number>();
    for (let i = 0; i < keys.length; i++) if (options.cohort !== 'common-fixed' || fixed(r.epochs[i])) set.add(keys[i]);
    return set;
  });
  const common = new Set(sets.length ? [...sets[0]].filter((k) => sets.every((s) => s.has(k))) : []);
  const base = projected.find((r) => r.id === options.baselineId) ?? projected[0];
  const universe = new Set<number>();
  if (base?.diagnostics.length) for (const k of rowKeys(base.diagnostics)) universe.add(k);
  else for (const r of projected) for (const k of epochKeys(r.epochs)) universe.add(k);
  const rows = projected.map((r) => {
    const keys = epochKeys(r.epochs);
    const samples = r.epochs.filter((e, i) =>
      options.cohort === 'fixed'
        ? fixed(e)
        : options.cohort === 'common' || options.cohort === 'common-fixed'
          ? common.has(keys[i])
          : true,
    );
    const actual = medianStep(rowKeys(r.diagnostics));
    const ct = continuity(r.epochs, options.motion, actual ?? estimateInterval(r.epochs));
    let countFixed = 0,
      countCarrier = 0,
      candidates = 0;
    for (let i = 0; i < keys.length; i++) {
      if (fixed(r.epochs[i])) countFixed++;
      if (carrier(r.epochs[i])) countCarrier++;
      if (universe.has(keys[i])) candidates++;
    }
    return {
      id: r.id,
      name: r.name,
      station: r.station,
      n: samples.length,
      valid: r.epochs.length,
      denominator: universe.size,
      coverage: universe.size ? candidates / universe.size : null,
      missing: universe.size - candidates,
      fixed: countFixed,
      carrier: countCarrier,
      fixedRate: arEnabled(r) && countCarrier ? countFixed / countCarrier : null,
      allRate: arEnabled(r) && r.diagnostics.length ? countFixed / r.diagnostics.length : null,
      arEnabled: arEnabled(r),
      axes: ['e', 'n', 'u'].map((k) => summarize(samples.map((e) => e[k as 'e' | 'n' | 'u']))),
      horizontal: summarize(samples.map((e) => Math.hypot(e.e, e.n))),
      spatial: summarize(samples.map((e) => Math.hypot(e.e, e.n, e.u))),
      continuity: ct,
      firstPpp: r.epochs.find(carrier)?.time,
      firstFixed: r.epochs.find(fixed)?.time,
      convergence: convergence(
        r.epochs,
        !!options.reference,
        options.horizontal,
        options.vertical,
        options.hold,
        ct.interval,
      ),
      samples,
      diagnostics: r.diagnostics,
    };
  });
  const baselineMap = new Map(rows.find((r) => r.id === base?.id)?.samples.map((e) => [keyOf(e), e]) ?? []);
  const pairs = projected
    .filter((r) => r.id !== base?.id)
    .map((r) => {
      const values = (rows.find((row) => row.id === r.id)?.samples ?? []).flatMap((e) => {
        const b = baselineMap.get(keyOf(e));
        if (!b) return [];
        return [{ ...e, e: e.e - b.e, n: e.n - b.n, u: e.u - b.u }];
      });
      return { ...r, name: `${r.name} − ${base?.name}`, epochs: values };
    });
  return { projected, extent, rows, commonCount: common.size, universe: universe.size, pairs };
}
export const format = (v: number | null | undefined, digits = 4) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
const eventKinds = { FltR: '滤波重置', SlS: '周跳卫星', Disc: '相位偏差不连续' } as const;
export function diagnosticEvents(history: RealtimeMetrics[]): Event[] {
  const events: Event[] = [];
  for (const m of history)
    for (const k of ['FltR', 'SlS', 'Disc'] as const) {
      const value = m[k];
      if (typeof value === 'number' && value > 0)
        events.push({ id: `${k}-${m.time}`, time: m.time, kind: eventKinds[k], detail: `${k} = ${value}`, value });
    }
  return events;
}
