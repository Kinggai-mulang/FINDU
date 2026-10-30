import type { Epoch } from '../../contracts';

/**
 * Display-only thinning for long time series. Statistics, events and exports never use it.
 *
 * Series up to `FULL_DETAIL_LIMIT` points are drawn completely, so every realtime buffer (at most 3600 epochs)
 * keeps full detail. Longer series keep, per pixel column, the first, lowest, highest and last point, which
 * preserves spikes and the visual envelope. Points flagged by `keep` (state changes, inspected epochs) always stay.
 */
export const FULL_DETAIL_LIMIT = 6000;
/** Pixel columns used for thinning; about one per pixel of a full-width chart, so the envelope looks continuous. */
export const DISPLAY_COLUMNS = 1200;

export function decimateIndices(
  times: ArrayLike<number>,
  values: ArrayLike<number | null | undefined>,
  columns: number,
  keep?: (index: number) => boolean,
  limit = FULL_DETAIL_LIMIT,
): number[] {
  const n = times.length;
  if (n <= limit) return Array.from({ length: n }, (_, i) => i);
  const first = times[0];
  const span = times[n - 1] - first;
  const count = Math.max(1, Math.floor(columns));
  if (!(span > 0)) return Array.from({ length: n }, (_, i) => i);
  const picked: number[] = [];
  let column = -1;
  let lo = -1;
  let hi = -1;
  let start = -1;
  let last = -1;
  const flush = () => {
    if (start < 0) return;
    // Emit in time order so the polyline does not double back inside a column.
    const set = [start, lo, hi, last].filter((v, i, a) => v >= 0 && a.indexOf(v) === i).sort((a, b) => a - b);
    picked.push(...set);
  };
  for (let i = 0; i < n; i++) {
    const c = Math.min(count - 1, Math.floor(((times[i] - first) / span) * count));
    // A forced point starts a new run inside its column, so the emitted order stays monotonic.
    if (c !== column || keep?.(i)) {
      flush();
      column = c;
      start = i;
      lo = hi = -1;
    }
    last = i;
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (lo < 0 || v < (values[lo] as number)) lo = i;
      if (hi < 0 || v > (values[hi] as number)) hi = i;
    }
  }
  flush();
  return picked;
}

/** True when a series is long enough that the chart shows the thinned envelope instead of every epoch. */
export const isThinned = (length: number, limit = FULL_DETAIL_LIMIT) => length > limit;

const thinCache = new WeakMap<Epoch[], Map<string, Epoch[]>>();
/**
 * Epochs to draw for one ENU component (`en` keeps the extremes of both, for the EN trajectory). Solution changes
 * are always kept so state colouring stays exact. Cached per epoch array, so live updates and re-renders are free.
 */
export function thinEpochs(epochs: Epoch[], key: 'e' | 'n' | 'u' | 'en'): Epoch[] {
  if (!isThinned(epochs.length)) return epochs;
  let byKey = thinCache.get(epochs);
  if (!byKey) thinCache.set(epochs, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;
  const times = epochs.map((e) => Date.parse(e.time));
  const keep = (i: number) => i > 0 && epochs[i].solution !== epochs[i - 1].solution;
  const pick = (k: 'e' | 'n' | 'u') =>
    decimateIndices(
      times,
      epochs.map((e) => e[k]),
      DISPLAY_COLUMNS,
      keep,
    );
  const indices = key === 'en' ? [...new Set([...pick('e'), ...pick('n')])].sort((a, b) => a - b) : pick(key);
  const out = indices.map((i) => epochs[i]);
  byKey.set(key, out);
  return out;
}
/** Above this many drawn points per series, symbols are hidden; the line itself carries the information. */
export const SYMBOL_LIMIT = 1500;
