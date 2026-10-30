import capacity from '../../contracts/capacity.json';
import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  EngineInfo,
  NativeRunRequest,
  NativeSnapshot,
  NativeTask,
  ResultSet,
  Task,
  RealtimeSnapshot,
  WorkbenchSnapshot,
} from '../../contracts';
import { defaultConfig } from '../domain';
import { isDesktop } from './files';
import { configFromOpt } from './options';
import { LiveSessionBuffer, type LiveCursor, type LiveDelta } from './live-buffers';

const sameItems = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);
const withConfig = (r: Omit<ResultSet, 'config'>): ResultSet => ({
  ...r,
  config: { ...defaultConfig, name: r.name, mode: r.solutionMode ?? defaultConfig.mode },
});
type DeltaRequest = { sessionId: string; cursor?: LiveCursor; withLogs: boolean };

/**
 * The only bridge between the UI and the Rust runtime. Polls once per second:
 * - `native_snapshot` and `realtime_overview` are small and always read;
 * - realtime buffers arrive through `realtime_deltas`, which returns only epochs the client does not hold,
 *   for the session shown in the monitor and for sessions in a live comparison;
 * - every snapshot slice keeps its identity until it changes, so `useEngine` subscribers re-render only then.
 */
export class WorkbenchEngine {
  private listeners = new Set<() => void>();
  private snapshot: WorkbenchSnapshot = { tasks: [], results: [], logs: [] };
  private native: NativeSnapshot = { tasks: [], logs: [], concurrency: 2 };
  private results = new Map<string, ResultSet>();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private errorReported = false;
  private liveSelectionVersion = 0;
  private analysisVisible = false;
  private realtimeVisible = true;
  private realtime?: RealtimeSnapshot;
  private sessions: RealtimeSnapshot[] = [];
  private buffers = new Map<string, LiveSessionBuffer>();
  private selectedLiveId?: string;
  private comparisonKeys: string[] = [];
  private liveResults: ResultSet[] = [];
  private publishedInputs: unknown[] = [];
  private nativeText?: string;
  private overviewText?: string;
  private mappedTasks = new WeakMap<NativeTask, Task>();
  private tasksFor?: NativeSnapshot;
  private visibleAnalysisIds?: Set<string>;
  getSnapshot = () => this.snapshot;

  private publish = () => {
    const incoming = [...this.results.values(), ...this.liveResults];
    const inputs = [this.native, this.realtime, this.sessions, ...incoming];
    if (sameItems(inputs, this.publishedInputs)) return;
    this.publishedInputs = inputs;
    const nativeChanged = this.tasksFor !== this.native;
    this.tasksFor = this.native;
    this.snapshot = {
      realtime: this.realtime,
      realtimeSessions: this.sessions,
      tasks: nativeChanged ? this.native.tasks.map((t) => this.task(t)) : this.snapshot.tasks,
      results: sameItems(incoming, this.snapshot.results) ? this.snapshot.results : incoming,
      logs: nativeChanged ? this.native.logs.slice(-500) : this.snapshot.logs,
    };
    this.listeners.forEach((fn) => fn());
  };

  private task(t: NativeTask): Task {
    const cached = this.mappedTasks.get(t);
    if (cached) return cached;
    const config = configFromOpt(t.request.document.text, t.name);
    const mapped: Task = {
      ...t,
      source: 'ipspos',
      request: { input: t.request.document.sourcePath, outputDir: t.outputDir, config },
      preview: t.preview ? ({ ...t.preview, config } as ResultSet) : undefined,
    };
    this.mappedTasks.set(t, mapped);
    return mapped;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (!this.timer && isDesktop()) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), 1000);
    }
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  };

  private buffer(key: string) {
    let b = this.buffers.get(key);
    if (!b) this.buffers.set(key, (b = new LiveSessionBuffer()));
    return b;
  }

  /** Fetch and apply incremental buffers; the detail session also receives its log tail. */
  private async readDeltas(keys: string[], detailKey?: string) {
    const requests: DeltaRequest[] = [...new Set(keys)].map((sessionId) => ({
      sessionId,
      cursor: this.buffers.get(sessionId)?.cursor(),
      withLogs: sessionId === detailKey,
    }));
    if (!requests.length) return;
    const deltas = await invoke<LiveDelta[]>('realtime_deltas', { requests });
    for (const delta of deltas) {
      const key = delta.summary.sessionKey;
      this.buffer(key).apply(delta, key === detailKey);
    }
  }

  private refreshLiveResults() {
    const next = this.comparisonKeys.flatMap((k) => this.buffers.get(k)?.result() ?? []);
    if (!sameItems(next, this.liveResults)) this.liveResults = next;
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const [native, sessions] = await Promise.all([
        invoke<NativeSnapshot>('native_snapshot'),
        invoke<RealtimeSnapshot[]>('realtime_overview'),
      ]);
      // Both payloads are small (no epoch histories), so a full comparison is cheap.
      const nativeText = JSON.stringify(native),
        overviewText = JSON.stringify(sessions);
      if (nativeText !== this.nativeText) {
        this.native = native;
        this.nativeText = nativeText;
      }
      if (overviewText !== this.overviewText) {
        this.sessions = sessions;
        this.overviewText = overviewText;
      }
      for (const key of this.buffers.keys()) if (!sessions.some((s) => s.sessionKey === key)) this.buffers.delete(key);

      let selected = this.selectedLiveId;
      if (selected === undefined && this.sessions.length) this.selectedLiveId = selected = this.sessions[0].sessionKey;
      const selectionVersion = this.liveSelectionVersion;
      const owner = this.sessions.find((s) => s.sessionKey === selected);
      const showDetail = this.realtimeVisible && !this.analysisVisible;
      const compare =
        this.comparisonKeys.length > 0 &&
        this.analysisVisible &&
        (this.visibleAnalysisIds === undefined ||
          this.comparisonKeys.some((k) => this.visibleAnalysisIds!.has(`live-${k}`)));
      if (compare)
        this.comparisonKeys = this.comparisonKeys.filter((k) => this.sessions.some((s) => s.sessionKey === k));
      const detailKey = showDetail && owner ? owner.sessionKey : undefined;
      await this.readDeltas([...(detailKey ? [detailKey] : []), ...(compare ? this.comparisonKeys : [])], detailKey);

      // A selection change while the request was in flight must not show the previous station's data.
      if (this.liveSelectionVersion === selectionVersion && this.selectedLiveId === selected && showDetail) {
        const detail = detailKey ? this.buffers.get(detailKey)?.snapshot() : undefined;
        this.realtime = detail && detail.sessionKey === selected && detail.id === owner?.id ? detail : undefined;
      }
      if (compare) this.refreshLiveResults();
      for (const t of this.native.tasks) {
        if (t.resultId && !this.results.has(t.resultId)) {
          const r = await invoke<Omit<ResultSet, 'config'>>('native_result', { id: t.resultId });
          this.results.set(t.resultId, { ...r, config: configFromOpt(t.request.document.text, t.name) });
        }
      }
      this.errorReported = false;
      this.publish();
    } catch (error) {
      if (!this.errorReported) {
        console.error('Native engine poll failed', error);
        this.errorReported = true;
      }
    } finally {
      this.polling = false;
    }
  }

  async submitNative(requests: NativeRunRequest[], concurrency: number) {
    const ids = await invoke<string[]>('submit_native', { requests, concurrency });
    await this.poll();
    return ids;
  }
  selectLive = (id: string) => {
    this.liveSelectionVersion++;
    this.selectedLiveId = id;
    this.realtime = undefined;
    this.publish();
    if (isDesktop()) void this.poll();
  };
  async compareLive(ids: string[]) {
    if (ids.length > capacity.comparisonResults) throw new Error(`一次最多对比 ${capacity.comparisonResults} 路方案`);
    await this.readDeltas(ids);
    this.comparisonKeys = ids.filter((k) => this.buffers.has(k));
    this.refreshLiveResults();
    this.publish();
    return this.liveResults.map((r) => r.id);
  }
  setAnalysisVisible = (visible: boolean) => {
    this.analysisVisible = visible;
  };
  setRealtimeVisible = (visible: boolean) => {
    this.realtimeVisible = visible;
  };
  setVisibleAnalysisResults = (ids: string[]) => {
    this.visibleAnalysisIds = new Set(ids);
  };
  removeLive = async (key: string) => {
    await invoke('remove_realtime', { sessionId: key });
    this.buffers.delete(key);
    this.comparisonKeys = this.comparisonKeys.filter((k) => k !== key);
    this.liveResults = this.liveResults.filter((r) => r.id !== `live-${key}`);
    if (this.selectedLiveId === key) {
      this.liveSelectionVersion++;
      this.selectedLiveId = undefined;
      this.realtime = undefined;
    }
    this.publish();
  };
  clearLiveComparison = () => {
    this.comparisonKeys = [];
    this.liveResults = [];
    this.publish();
  };
  info = () => invoke<EngineInfo>('engine_info');
  dismissNative = async (ids: string[]) => {
    await invoke('dismiss_native', { ids });
    ids.forEach((id) => this.results.delete(id));
    await this.poll();
  };
  openNativeFolder = (id: string) => invoke('open_native_folder', { id });
  async importResults(paths: string[]) {
    const incoming = await invoke<Omit<ResultSet, 'config'>[]>('import_analysis', { paths });
    for (const r of incoming) this.results.set(r.id, withConfig(r));
    this.publish();
    return incoming.map((r) => r.id);
  }
  async openArchived(id: string) {
    const r = await invoke<Omit<ResultSet, 'config'>>('open_analysis', { id });
    this.results.set(r.id, withConfig(r));
    this.publish();
    return r.id;
  }
  cancelTask = (id: string) => {
    if (this.native.tasks.some((t) => t.id === id)) {
      void invoke('cancel_native', { id })
        .then(() => this.poll())
        .catch(console.error);
    }
  };
}
export const workbenchEngine = new WorkbenchEngine();

/**
 * Subscribe to one slice of the workbench snapshot. Return a property of the snapshot, never a derived array,
 * so components re-render only when that slice changes.
 */
export function useEngine<T>(select: (snapshot: WorkbenchSnapshot) => T): T {
  return useSyncExternalStore(workbenchEngine.subscribe, () => select(workbenchEngine.getSnapshot()));
}
