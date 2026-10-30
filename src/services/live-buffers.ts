import type { Epoch, RealtimeMetrics, RealtimeSnapshot, ResultSet } from '../../contracts';
import { defaultConfig } from '../domain';

/** Items with sequence numbers `from..end`; the server keeps `start..end`. Mirrors `BufferSlice` in realtime.rs. */
export interface Slice<T> {
  start: number;
  from: number;
  end: number;
  items: T[];
}
export type LogLine = { time: string; line: string };
export interface LiveDelta {
  summary: RealtimeSnapshot;
  generation: number;
  epochs: Slice<Epoch>;
  history: Slice<RealtimeMetrics>;
  productHistory: Slice<RealtimeMetrics>;
  logs: Slice<LogLine>;
}
export interface Held<T> {
  start: number;
  end: number;
  items: T[];
}
export interface LiveCursor {
  runId: string;
  generation: number;
  ends: { epochs: number; history: number; products: number; logs: number };
}

/**
 * Apply one slice to a local copy. Unchanged buffers keep their array identity, so React memos and
 * chart updates only run when an epoch actually arrived.
 */
export function mergeSlice<T>(held: Held<T> | undefined, slice: Slice<T>): Held<T> {
  if (!held || slice.from < held.start || slice.from > held.end) {
    return { start: slice.from, end: slice.end, items: slice.items };
  }
  const resentOnly = slice.end === held.end && slice.start === held.start && slice.items.length <= 1;
  if (resentOnly && (slice.items.length === 0 || sameJson(slice.items[0], held.items.at(-1)))) return held;
  let items = held.items.slice(0, slice.from - held.start).concat(slice.items);
  let start = held.start;
  if (start < slice.start) {
    items = items.slice(slice.start - start);
    start = slice.start;
  }
  return { start, end: slice.end, items };
}
const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Local mirror of one realtime session; replaced wholesale when the run or generation changes. */
export class LiveSessionBuffer {
  runId = '';
  generation = -1;
  epochs?: Held<Epoch>;
  history?: Held<RealtimeMetrics>;
  products?: Held<RealtimeMetrics>;
  logs?: Held<LogLine>;
  summary?: RealtimeSnapshot;
  private detail?: RealtimeSnapshot;
  private detailSummary?: string;
  private comparison?: { key: unknown[]; result: ResultSet };

  cursor(): LiveCursor | undefined {
    if (!this.runId) return undefined;
    return {
      runId: this.runId,
      generation: this.generation,
      ends: {
        epochs: this.epochs?.end ?? 0,
        history: this.history?.end ?? 0,
        products: this.products?.end ?? 0,
        // Logs are fetched only for the detail view; an empty cursor makes the first request complete.
        logs: this.logs?.end ?? 0,
      },
    };
  }

  apply(delta: LiveDelta, withLogs: boolean) {
    if (delta.summary.id !== this.runId || delta.generation !== this.generation) {
      this.epochs = this.history = this.products = undefined;
      if (delta.summary.id !== this.runId) this.logs = undefined;
      this.runId = delta.summary.id;
      this.generation = delta.generation;
    }
    this.summary = delta.summary;
    this.epochs = mergeSlice(this.epochs, delta.epochs);
    this.history = mergeSlice(this.history, delta.history);
    this.products = mergeSlice(this.products, delta.productHistory);
    if (withLogs) this.logs = mergeSlice(this.logs, delta.logs);
  }

  /** Same shape as the former full snapshot, so the monitor views did not change. */
  snapshot(): RealtimeSnapshot | undefined {
    const s = this.summary;
    if (!s) return undefined;
    const epochs = this.epochs?.items ?? [];
    const history = this.history?.items ?? [];
    const productHistory = this.products?.items ?? [];
    const logs = this.logs?.items ?? [];
    const d = this.detail;
    const summaryText = JSON.stringify(s);
    if (
      d &&
      d.epochs === epochs &&
      d.history === history &&
      d.productHistory === productHistory &&
      d.logs === logs &&
      summaryText === this.detailSummary
    ) {
      return d;
    }
    this.detailSummary = summaryText;
    // bufferedEpochs stays the server value (same lock as the slice), which the view uses to tell loading from empty.
    this.detail = { ...s, epochs, history, productHistory, logs };
    return this.detail;
  }

  /** Port of `comparison_snapshot` in live_hub.rs: epochs without a diagnostic row are left out. */
  result(): ResultSet | undefined {
    const s = this.summary;
    if (!s || s.solutionMode === 'RECORD') return undefined;
    const epochs = this.epochs?.items ?? [];
    const history = this.history?.items ?? [];
    const productHistory = this.products?.items ?? [];
    const key = [
      epochs,
      history,
      productHistory,
      s.label,
      s.station,
      s.referenceXyz?.join(','),
      s.heartbeat?.arrivalUnix,
    ];
    if (this.comparison && this.comparison.key.every((v, i) => v === key[i])) return this.comparison.result;
    const times = new Set(history.map((m) => m.time));
    const kept = epochs.filter((e) => times.has(e.time));
    const result: ResultSet = {
      id: `live-${s.sessionKey}`,
      name: s.label,
      station: s.station,
      source: 'ipspos',
      epochs: kept,
      referenceXyz: s.referenceXyz ?? undefined,
      referenceKind: 'first-valid',
      totalRows: history.length,
      rejectedRows: Math.max(0, history.length - kept.length),
      qualityCounts: {},
      outputDir: s.outputDir,
      logPath: s.logPath ?? '',
      engineCommit: s.engineCommit,
      diagnostics: history,
      analysisConfig: s.analysisConfig,
      duplicateRows: 0,
      isLiveCache: true,
      productHistory,
      runId: s.id,
      solutionMode: s.solutionMode as ResultSet['solutionMode'],
      logVersion: s.logVersion,
      engineBuildId: s.engineBuildId,
      ntripLogPath: s.ntripLogPath,
      productLogPath: s.productLogPath,
      clientStatus: s.heartbeat,
      config: {
        ...defaultConfig,
        name: s.label,
        mode: (s.solutionMode as ResultSet['config']['mode']) ?? defaultConfig.mode,
      },
    };
    this.comparison = { key, result };
    return result;
  }
}
