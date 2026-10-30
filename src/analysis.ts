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
export const median = (v: number[]) => quantile(v, 0.5);
export function quantile(v: number[], p: number): number | null {
  if (!v.length) return null;
  // Typed-array sort is numeric and native, several times faster than a comparator on 170 000 values.
  const a = Float64Array.from(v).sort(),
    i = (a.length - 1) * p,
    k = Math.floor(i);
  return a[k] + (a[Math.min(k + 1, a.length - 1)] - a[k]) * (i - k);
}
export function summarize(values: number[]) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return { n: 0, mean: null, rms: null, std: null, p95: null, max: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return {
    n: v.length,
    mean,
    rms: Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length),
    std: Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length),
    p95: quantile(v.map(Math.abs), 0.95),
    max: v.reduce((a, b) => Math.max(a, Math.abs(b)), 0),
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
export function estimateInterval(epochs: Epoch[]): number {
  const differences = epochs
    .slice(1)
    .map((e, i) => (keyOf(e) - keyOf(epochs[i])) / 1000)
    .filter((n) => n > 0);
  return median(differences) ?? 1;
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
  for (let i = 0; i < epochs.length; i++) {
    const e = epochs[i],
      prev = epochs[i - 1],
      dt = prev ? (keyOf(e) - keyOf(prev)) / 1000 : 0;
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
        segment.seconds = (keyOf(e) - segmentKey) / 1000;
      } else {
        segment = { start: e.time, end: e.time, n: 1, seconds: 0 };
        segmentKey = keyOf(e);
        segments.push(segment);
      }
    } else segment = undefined;
  }
  for (const s of [...steps].sort((a, b) => b.value - a.value).slice(0, 10))
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
  let start: Epoch | undefined, last: Epoch | undefined;
  for (const e of epochs) {
    if (
      !carrier(e) ||
      Math.hypot(e.e, e.n) > horizontal ||
      Math.abs(e.u) > vertical ||
      (last && (keyOf(e) - keyOf(last)) / 1000 > interval * 1.5)
    ) {
      start = undefined;
    }
    if (carrier(e) && Math.hypot(e.e, e.n) <= horizontal && Math.abs(e.u) <= vertical) {
      start ??= e;
      if ((keyOf(e) - keyOf(start)) / 1000 >= hold) return start.time;
    }
    last = e;
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
  const sets = projected.map(
    (r) => new Set(r.epochs.filter((e) => (options.cohort === 'common-fixed' ? fixed(e) : true)).map(keyOf)),
  );
  const common = new Set(sets.length ? [...sets[0]].filter((k) => sets.every((s) => s.has(k))) : []);
  const base = projected.find((r) => r.id === options.baselineId) ?? projected[0];
  const universe = new Set(
    base?.diagnostics.length ? base.diagnostics.map(metricKey) : projected.flatMap((r) => r.epochs.map(keyOf)),
  );
  const rows = projected.map((r) => {
    const samples = r.epochs.filter((e) =>
      options.cohort === 'fixed'
        ? fixed(e)
        : options.cohort === 'common' || options.cohort === 'common-fixed'
          ? common.has(keyOf(e))
          : true,
    );
    const keys = r.diagnostics.map(metricKey);
    const actual = median(
      keys
        .slice(1)
        .map((k, i) => (k - keys[i]) / 1000)
        .filter((v) => v > 0),
    );
    const ct = continuity(r.epochs, options.motion, actual ?? estimateInterval(r.epochs));
    const countFixed = r.epochs.filter(fixed).length,
      countCarrier = r.epochs.filter(carrier).length;
    const candidates = r.epochs.filter((e) => universe.has(keyOf(e)));
    return {
      id: r.id,
      name: r.name,
      station: r.station,
      n: samples.length,
      valid: r.epochs.length,
      denominator: universe.size,
      coverage: universe.size ? candidates.length / universe.size : null,
      missing: universe.size - candidates.length,
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
export function diagnosticEvents(history: RealtimeMetrics[]): Event[] {
  return history.flatMap((m) =>
    ['FltR', 'SlS', 'Disc'].flatMap((k) =>
      typeof m[k] === 'number' && m[k] > 0
        ? [
            {
              id: `${k}-${m.time}`,
              time: m.time,
              kind: { FltR: '滤波重置', SlS: '周跳卫星', Disc: '相位偏差不连续' }[k]!,
              detail: `${k} = ${m[k]}`,
              value: m[k] as number,
            },
          ]
        : [],
    ),
  );
}
