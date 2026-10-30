import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Epoch, RealtimeMetrics, RealtimeSnapshot } from '../contracts';
import type { LiveDelta, Slice } from '../src/services/live-buffers';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => bridge);
vi.mock('../src/services/files', () => ({ isDesktop: () => false }));
import { WorkbenchEngine } from '../src/services/native-engine';

/** In-memory stand-in for LiveHub; `slice` follows realtime.rs exactly (cap, resend of the last held row). */
class FakeHub {
  sessions = new Map<
    string,
    {
      summary: RealtimeSnapshot;
      generation: number;
      history: RealtimeMetrics[];
      epochs: Epoch[];
      products: RealtimeMetrics[];
      logs: { time: string; line: string }[];
      ends: Record<'history' | 'epochs' | 'products' | 'logs', number>;
    }
  >();
  calls: { cmd: string; args: unknown }[] = [];
  cap = 3600;
  add(key: string, run = `run-${key}`, extra: Partial<RealtimeSnapshot> = {}) {
    this.sessions.set(key, {
      summary: {
        sessionKey: key,
        id: run,
        label: key,
        station: 'S',
        state: 'running',
        solutionMode: 'PPP',
        ...extra,
      } as RealtimeSnapshot,
      generation: 0,
      history: [],
      epochs: [],
      products: [],
      logs: [],
      ends: { history: 0, epochs: 0, products: 0, logs: 0 },
    });
  }
  push(key: string, n = 1) {
    const s = this.sessions.get(key)!;
    for (let k = 0; k < n; k++) {
      const i = s.ends.history;
      const time = new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();
      s.history.push({ time, solution: 'FLOAT', Q: 5, ZWD: i });
      s.epochs.push({ time, e: i, n: 0, u: 0, satellites: 20, solution: 'FLOAT' });
      s.logs.push({ time, line: `line ${i}` });
      s.ends.history++;
      s.ends.epochs++;
      s.ends.logs++;
      for (const [arr, cap] of [
        [s.history, this.cap],
        [s.epochs, this.cap],
        [s.logs, 500],
      ] as const)
        if (arr.length > cap) arr.shift();
    }
    s.summary = { ...s.summary, metrics: s.history.at(-1) ?? null } as RealtimeSnapshot;
  }
  private slice<T>(items: T[], end: number, held?: number): Slice<T> {
    const start = end - items.length;
    const from = held !== undefined && held > start && held <= end ? held - 1 : start;
    return { start, from, end, items: items.slice(from - start) };
  }
  invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    this.calls.push({ cmd, args });
    if (cmd === 'native_snapshot') return { tasks: [], logs: [], concurrency: 2 };
    if (cmd === 'realtime_overview') return [...this.sessions.values()].map((s) => structuredClone(s.summary));
    if (cmd === 'remove_realtime') return this.sessions.delete(args.sessionId as string);
    if (cmd === 'realtime_deltas') {
      const requests = args.requests as {
        sessionId: string;
        cursor?: { runId: string; generation: number; ends: Record<string, number> };
        withLogs: boolean;
      }[];
      return requests.flatMap(({ sessionId, cursor, withLogs }): LiveDelta[] => {
        const s = this.sessions.get(sessionId);
        if (!s) return [];
        const held =
          cursor && cursor.runId === s.summary.id && cursor.generation === s.generation ? cursor.ends : undefined;
        return [
          structuredClone({
            summary: s.summary,
            generation: s.generation,
            history: this.slice(s.history, s.ends.history, held?.history),
            epochs: this.slice(s.epochs, s.ends.epochs, held?.epochs),
            productHistory: this.slice(s.products, s.ends.products, held?.products),
            logs: withLogs
              ? this.slice(s.logs, s.ends.logs, held?.logs)
              : { start: s.ends.logs, from: s.ends.logs, end: s.ends.logs, items: [] },
          }),
        ];
      });
    }
    throw Error(cmd);
  };
  deltaCalls() {
    return this.calls.filter((c) => c.cmd === 'realtime_deltas') as {
      cmd: string;
      args: { requests: { sessionId: string; withLogs: boolean }[] };
    }[];
  }
}
const poll = (e: WorkbenchEngine) => (e as unknown as { poll: () => Promise<void> }).poll();
let hub: FakeHub;
beforeEach(() => {
  hub = new FakeHub();
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(hub.invoke);
});

describe('incremental realtime detail', () => {
  it('refreshes every poll and transfers only the new epochs after the first read', async () => {
    hub.add('a');
    hub.push('a', 3600);
    const e = new WorkbenchEngine();
    e.selectLive('a');
    await poll(e);
    expect(e.getSnapshot().realtime?.history).toHaveLength(3600);
    const before = e.getSnapshot().realtime;
    hub.push('a', 2);
    hub.calls = [];
    await poll(e);
    const delta = (await hub.invoke('realtime_deltas', hub.deltaCalls()[0].args as never)) as LiveDelta[];
    // The last held row is resent with the two new rows; the 3598 older rows are not transferred again.
    expect(delta[0].history.items).toHaveLength(3);
    const now = e.getSnapshot().realtime!;
    expect(now).not.toBe(before);
    expect(now.history).toHaveLength(3600);
    expect(now.history.at(-1)?.ZWD).toBe(3601);
    expect(now.history[0].ZWD).toBe(2);
    expect(now.logs.at(-1)?.line).toBe('line 3601');
  });

  it('keeps the same snapshot when nothing new arrived', async () => {
    hub.add('a');
    hub.push('a', 10);
    const e = new WorkbenchEngine();
    e.selectLive('a');
    await poll(e);
    const first = e.getSnapshot();
    await poll(e);
    expect(e.getSnapshot()).toBe(first);
  });

  it('resets local buffers when the session restarts with a new run', async () => {
    hub.add('a', 'run-1');
    hub.push('a', 50);
    const e = new WorkbenchEngine();
    e.selectLive('a');
    await poll(e);
    hub.add('a', 'run-2');
    hub.push('a', 5);
    await poll(e);
    expect(e.getSnapshot().realtime?.id).toBe('run-2');
    expect(e.getSnapshot().realtime?.history).toHaveLength(5);
  });

  it('stops detail transfer on other pages but keeps the overview, then catches up', async () => {
    hub.add('a');
    hub.push('a', 10);
    const e = new WorkbenchEngine();
    e.selectLive('a');
    await poll(e);
    e.setRealtimeVisible(false);
    hub.calls = [];
    hub.push('a', 4);
    for (let i = 0; i < 5; i++) await poll(e);
    expect(hub.deltaCalls()).toHaveLength(0);
    expect(hub.calls.filter((c) => c.cmd === 'realtime_overview')).toHaveLength(5);
    e.setRealtimeVisible(true);
    await poll(e);
    expect(e.getSnapshot().realtime?.history).toHaveLength(14);
  });
});

describe('live session ownership', () => {
  it('discards an in-flight detail after switching stations', async () => {
    hub.add('a');
    hub.add('b');
    hub.push('a', 3);
    hub.push('b', 7);
    let release!: () => void;
    bridge.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'realtime_deltas' && (args.requests as { sessionId: string }[])[0].sessionId === 'a')
        await new Promise<void>((r) => (release = r));
      return hub.invoke(cmd, args);
    });
    const e = new WorkbenchEngine();
    e.selectLive('a');
    const old = poll(e);
    while (!release) await new Promise((r) => setTimeout(r, 0));
    e.selectLive('b');
    release();
    await old;
    expect(e.getSnapshot().realtime).toBeUndefined();
    await poll(e);
    expect(e.getSnapshot().realtime?.sessionKey).toBe('b');
    expect(e.getSnapshot().realtime?.history).toHaveLength(7);
  });

  it('never substitutes another session for an unstarted key', async () => {
    hub.add('other');
    const e = new WorkbenchEngine();
    e.selectLive('pending');
    await poll(e);
    expect(hub.deltaCalls()).toHaveLength(0);
    expect(e.getSnapshot().realtime).toBeUndefined();
  });
});

describe('live comparison', () => {
  it('compares six sessions incrementally, follows new epochs and rejects a seventh', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `s${i}`);
    ids.forEach((id) => {
      hub.add(id);
      hub.push(id, 100);
    });
    const e = new WorkbenchEngine();
    e.setAnalysisVisible(true);
    expect(await e.compareLive(ids)).toEqual(ids.map((id) => `live-${id}`));
    expect(e.getSnapshot().results.every((r) => r.epochs.length === 100 && r.isLiveCache)).toBe(true);
    ids.forEach((id) => hub.push(id, 1));
    await poll(e);
    expect(e.getSnapshot().results.every((r) => r.diagnostics?.length === 101)).toBe(true);
    expect(
      hub
        .deltaCalls()
        .at(-1)!
        .args.requests.every((r) => !r.withLogs),
    ).toBe(true);
    hub.calls = [];
    await expect(e.compareLive([...ids, 'seventh'])).rejects.toThrow('6');
    expect(hub.calls).toHaveLength(0);
  });

  it('pauses while an archive is shown, keeps cached results, and resumes', async () => {
    hub.add('a');
    hub.push('a', 5);
    const e = new WorkbenchEngine();
    e.setAnalysisVisible(true);
    await e.compareLive(['a']);
    const saved = e.getSnapshot().results.find((r) => r.id === 'live-a');
    e.setVisibleAnalysisResults(['archived']);
    hub.push('a', 2);
    hub.calls = [];
    await poll(e);
    expect(hub.deltaCalls()).toHaveLength(0);
    expect(e.getSnapshot().results.find((r) => r.id === 'live-a')).toBe(saved);
    e.setVisibleAnalysisResults(['live-a']);
    await poll(e);
    expect(e.getSnapshot().results.find((r) => r.id === 'live-a')?.diagnostics).toHaveLength(7);
  });

  it('keeps a comparison when removal is rejected and releases it afterwards; clear and reopen work', async () => {
    hub.add('a');
    hub.push('a', 3);
    let reject = true;
    bridge.invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'remove_realtime' && reject) throw Error('请先停止');
      return hub.invoke(cmd, args);
    });
    const e = new WorkbenchEngine();
    await e.compareLive(['a']);
    await expect(e.removeLive('a')).rejects.toThrow('请先停止');
    expect(e.getSnapshot().results.some((r) => r.id === 'live-a')).toBe(true);
    e.clearLiveComparison();
    expect(e.getSnapshot().results.some((r) => r.id === 'live-a')).toBe(false);
    await e.compareLive(['a']);
    expect(e.getSnapshot().results.some((r) => r.id === 'live-a')).toBe(true);
    reject = false;
    await e.removeLive('a');
    expect(e.getSnapshot().results.some((r) => r.id === 'live-a')).toBe(false);
  });
});

describe('unchanged polling', () => {
  it('retains snapshot identity without changes and publishes new native logs only', async () => {
    let logs: unknown[] = [];
    bridge.invoke.mockImplementation(async (cmd: string) =>
      cmd === 'native_snapshot' ? structuredClone({ tasks: [], logs, concurrency: 2 }) : [],
    );
    const e = new WorkbenchEngine();
    const changed = vi.fn();
    const off = e.subscribe(changed);
    await poll(e);
    const first = e.getSnapshot();
    const calls = changed.mock.calls.length;
    for (let i = 0; i < 5; i++) await poll(e);
    expect(e.getSnapshot()).toBe(first);
    expect(changed).toHaveBeenCalledTimes(calls);
    logs = [{ id: 1, time: '2026-10-01T00:00:00Z', level: 'info', message: 'new log' }];
    await poll(e);
    expect(e.getSnapshot()).not.toBe(first);
    expect(e.getSnapshot().results).toBe(first.results);
    expect(e.getSnapshot().tasks).not.toBe(undefined);
    expect(e.getSnapshot().logs.some((l) => l.message === 'new log')).toBe(true);
    off();
  });
});
