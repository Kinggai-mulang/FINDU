// Desktop performance benchmark: realtime detail, realtime comparison and large post-processing analysis.
//
// Start a stopped, isolated FINDU copy with WebView2 remote debugging, then run:
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9297'; .\FINDU.exe
//   node tests/perf-desktop.mjs --label before --logs "<a.log>|<b.log>"
// Realtime scenarios replace realtime IPC with an in-page fixture server, so no NTRIP stream is needed.
// The analysis scenario loads real Log=4 files through the UI path input.
// Results are written to runtime/perf/<label>.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, value, i, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
const label = args.label ?? 'run';
const endpoint = process.env.FINDYOU_CDP ?? 'http://127.0.0.1:9297';
const windowSeconds = Number(args.seconds ?? 20);
const only = args.only?.split(',');
const logs = args.logs?.split('|').filter(Boolean) ?? [];
const outputDir = path.resolve('runtime/perf');
await fs.mkdir(outputDir, { recursive: true });

let browser;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    browser = await chromium.connectOverCDP(endpoint);
    break;
  } catch (error) {
    if (attempt === 39) throw error;
    await new Promise((r) => setTimeout(r, 500));
  }
}
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(120000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForSelector('.nav-item');
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');

const existing = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('realtime_overview'));
if (existing.some((s) => ['starting', 'running', 'stopping'].includes(s.state))) {
  await browser.close();
  throw Error('Realtime sessions are active; use a stopped isolated copy');
}

async function metrics() {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

/** Main-thread time and heap across a callback; TaskDuration is the busy time of the renderer main thread. */
async function measure(run) {
  await page.evaluate(() => {
    window.__longTasks = [];
    window.__longObserver?.disconnect();
    window.__longObserver = new PerformanceObserver((list) =>
      window.__longTasks.push(...list.getEntries().map((e) => e.duration)),
    );
    window.__longObserver.observe({ type: 'longtask' });
  });
  const before = await metrics();
  const started = Date.now();
  const extra = await run();
  const elapsed = (Date.now() - started) / 1000;
  const after = await metrics();
  const long = await page.evaluate(() => window.__longTasks);
  return {
    elapsedSec: +elapsed.toFixed(2),
    mainThreadBusySec: +(after.TaskDuration - before.TaskDuration).toFixed(2),
    busyPercent: +((100 * (after.TaskDuration - before.TaskDuration)) / elapsed).toFixed(1),
    scriptSec: +(after.ScriptDuration - before.ScriptDuration).toFixed(2),
    layoutSec: +(after.LayoutDuration - before.LayoutDuration).toFixed(2),
    longTasks: long.length,
    longestTaskMs: Math.round(Math.max(0, ...long)),
    heapMiB: +(after.JSHeapUsedSize / 1048576).toFixed(1),
    ...extra,
  };
}

/** Wait until no long task has occurred for quietMs, so a click is measured until the UI settles. */
async function settle(quietMs = 1200, limitMs = 90000) {
  const started = Date.now();
  await page.evaluate(() => {
    window.__lastLong = performance.now();
    window.__settleObserver?.disconnect();
    window.__settleObserver = new PerformanceObserver(() => (window.__lastLong = performance.now()));
    window.__settleObserver.observe({ type: 'longtask' });
  });
  while (Date.now() - started < limitMs) {
    const idle = await page.evaluate(() => performance.now() - window.__lastLong);
    if (idle >= quietMs) break;
    await page.waitForTimeout(200);
  }
  return { settleSec: +((Date.now() - started - quietMs) / 1000).toFixed(2) };
}

/** Record how often a text changes; realtime views must keep refreshing about once per second. */
async function freshness(read, seconds) {
  const changes = [];
  let last = await read();
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(100);
    const now = await read();
    if (now !== last) {
      changes.push(Date.now());
      last = now;
    }
  }
  const gaps = changes.slice(1).map((t, i) => (t - changes[i]) / 1000);
  return {
    updates: changes.length,
    meanUpdateGapSec: gaps.length ? +(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(2) : null,
    maxUpdateGapSec: gaps.length ? +Math.max(...gaps).toFixed(2) : null,
  };
}

/** Synthetic Log=4 history with every diagnostic column of a PPP-AR log. */
function fixtureSessions(count, epochs) {
  const keys =
    'Q VQ AS AC Obs OC Com IFBSup Disc PreP PreL SlS SlL AmbR FltR SppS DopS DopN TcpS TcpN TdSl FloIn FloUse UDS SDS DDS nSIFB nIFB NP NL PDn PRj LDn LRj CanS CanA SchA InstA FixS FixA APN ALN ACN HDOP VDOP PNRMS LNRMS FPRMS FLRMS AHDOP AVDOP Ratio ADOP DPos APRMS ALRMS PCR ADR BRAge ZHD ZWD TrpSRMS IonDRMS ZWDUCor IAC50 IAC95'.split(
      ' ',
    );
  return Array.from({ length: count }, (_, s) => ({ key: `perf-${s}`, keys, epochs, seed: s }));
}

async function installRealtimeServer(sessions) {
  await page.evaluate((specs) => {
    const start = Date.now() - 3600 * 1000;
    const row = (spec, i) => {
      const time = new Date(start + i * 1000).toISOString();
      const m = {
        time,
        solution: i % 10 ? 'FIX' : 'FLOAT',
        X: -2267808 + Math.sin(i / 50) * 0.02,
        Y: 5009321,
        Z: 3221021,
      };
      spec.keys.forEach((k, j) => (m[k] = +(Math.abs(Math.sin(i / 97 + j + spec.seed)) * 30).toFixed(3)));
      m.ZWDUCor = +(Math.sin(i / 300) * 0.5).toFixed(3);
      m.IAC50 = 0.9;
      m.IAC95 = 0.98;
      return m;
    };
    const epoch = (m, i) => ({
      time: m.time,
      e: Math.sin(i / 60) * 0.02,
      n: Math.cos(i / 70) * 0.02,
      u: Math.sin(i / 90) * 0.05,
      x: m.X,
      y: m.Y,
      z: m.Z,
      satellites: 28,
      solution: m.solution,
      rawQuality: m.solution === 'FIX' ? 7 : 5,
      gpsWeek: 2442,
      tow: 100000 + i,
    });
    const server = (window.perfServer = { sessions: new Map(), tick: 0 });
    for (const spec of specs) {
      const history = Array.from({ length: spec.epochs }, (_, i) => row(spec, i));
      server.sessions.set(spec.key, {
        spec,
        history,
        epochs: history.map(epoch),
        next: spec.epochs,
        received: spec.epochs,
      });
    }
    const advance = () => {
      for (const s of server.sessions.values()) {
        const m = row(s.spec, s.next);
        s.history.push(m);
        s.epochs.push(epoch(m, s.next));
        if (s.history.length > 3600) {
          s.history.shift();
          s.epochs.shift();
        }
        s.next++;
        s.received++;
      }
    };
    server.timer = setInterval(advance, 1000);
    const nowIso = () => new Date().toISOString();
    const snapshot = (s, full) => {
      const latest = s.history.at(-1);
      return {
        sessionKey: s.spec.key,
        label: `${String(s.spec.seed + 1).padStart(2, '0')}_PERF`,
        station: 'PERF',
        sourcePath: `C:/perf/${s.spec.key}.opt`,
        analysisConfig: { GNSS_PMode: '2', GNSS_ARMode: '2', GNSS_RoveSampleTime: '1' },
        epochIntervalSeconds: 1,
        state: 'running',
        configName: `${s.spec.key}.opt`,
        productType: 'SSR',
        logPath: `C:/perf/${s.spec.key}.log`,
        parseError: null,
        logUpdatedAt: nowIso(),
        id: `run-${s.spec.key}`,
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        outputDir: `C:/perf/${s.spec.key}`,
        processId: 1,
        engineCommit: 'perf',
        heartbeat: {
          schemaVersion: 1,
          arrivalUnix: Date.now() / 1000,
          week: 2442,
          tow: 100000,
          streams: [
            {
              role: 'ROVE',
              state: 2,
              errorCode: 0,
              httpStatus: 200,
              reconnects: 0,
              bytes: 1e6,
              frames: 1e4,
              hasPages: 0,
              lastArrival: Date.now() / 1000,
              queued: 0,
              committed: 1e4,
              dropped: 0,
            },
          ],
          products: [],
        },
        bufferedEpochs: s.epochs.length,
        epochs: full ? s.epochs : [],
        metrics: latest,
        history: full ? s.history : [],
        productHistory: [],
        logs: full
          ? Array.from({ length: 200 }, (_, i) => ({ time: nowIso(), line: `perf log line ${s.next - i}` }))
          : [],
        error: null,
        referenceXyz: null,
        receivedEpochs: s.received,
        solutionMode: 'PPP',
        logVersion: 4,
      };
    };
    const result = (s) => ({
      id: `live-${s.spec.key}`,
      name: `${String(s.spec.seed + 1).padStart(2, '0')}_PERF`,
      station: 'PERF',
      source: 'ipspos',
      epochs: s.epochs,
      referenceKind: 'first-valid',
      totalRows: s.epochs.length,
      rejectedRows: 0,
      qualityCounts: {},
      outputDir: '',
      logPath: '',
      engineCommit: 'perf',
      diagnostics: s.history,
      analysisConfig: { GNSS_PMode: '2', GNSS_ARMode: '2' },
      duplicateRows: 0,
      isLiveCache: true,
      productHistory: [],
      runId: `run-${s.spec.key}`,
      solutionMode: 'PPP',
      logVersion: 4,
    });
    window.perfHandlers = {
      realtime_overview: () => [...server.sessions.values()].map((s) => snapshot(s, false)),
      realtime_snapshot: (body) => snapshot(server.sessions.get(body.sessionId), true),
      realtime_results: (body) => body.ids.map((id) => result(server.sessions.get(id))),
    };
    const original = (window.__perfFetch ??= window.fetch.bind(window));
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const cmd = url?.startsWith('http://ipc.localhost/') ? new URL(url).pathname.slice(1) : '';
      const handler = window.perfHandlers[cmd];
      if (!handler) return original(input, init);
      const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : {};
      return new Response(JSON.stringify(handler(body)), {
        headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'ok' },
      });
    };
  }, sessions);
}

async function removeRealtimeServer() {
  await page.evaluate(() => {
    clearInterval(window.perfServer?.timer);
    if (window.__perfFetch) window.fetch = window.__perfFetch;
  });
}

const report = {
  label,
  at: new Date().toISOString(),
  version: await page.evaluate(() => document.querySelector('.sidebar-version')?.textContent),
  scenarios: {},
};
const want = (name) => !only || only.includes(name);
const collapse = page.getByRole('button', { name: '折叠日志面板', exact: true });
if (await collapse.count()) await collapse.click();

try {
  if (want('realtime-detail')) {
    await installRealtimeServer(fixtureSessions(1, 3600));
    await page.getByRole('button', { name: /实时监控/ }).click();
    await page.getByRole('button', { name: '切换 01_PERF', exact: true }).click();
    await page.waitForTimeout(3000);
    const readReceived = () => page.locator('.ant-table-tbody tr.ant-table-row').first().innerText();
    report.scenarios['realtime-detail'] = await measure(() => freshness(readReceived, windowSeconds));
    await removeRealtimeServer();
  }
  if (want('realtime-compare')) {
    await installRealtimeServer(fixtureSessions(6, 3600));
    await page.getByRole('button', { name: /实时监控/ }).click();
    await page.waitForTimeout(2000);
    await page.locator('.ant-table-thead .ant-checkbox-input').first().check({ force: true });
    await page.getByRole('button', { name: '实时对比所选' }).click();
    await page.getByRole('tab', { name: '结果总览' }).waitFor();
    await page.waitForTimeout(3000);
    // The analysed UTC span moves forward every second while the comparison follows the live sessions.
    const readCount = () =>
      page
        .locator('[aria-label="分析时间跨度"]')
        .first()
        .innerText()
        .catch(() => '');
    report.scenarios['realtime-compare:overview'] = await measure(() => freshness(readCount, windowSeconds));
    await page.getByRole('tab', { name: '定位与连续性' }).click();
    await page.waitForSelector('canvas');
    await page.waitForTimeout(3000);
    report.scenarios['realtime-compare:position'] = await measure(() => freshness(readCount, windowSeconds));
    await page.getByRole('tab', { name: '结果总览' }).click();
    await removeRealtimeServer();
  }
  if (want('analysis') && logs.length) {
    await page.getByRole('button', { name: /分析对比/ }).click();
    await page.getByLabel('分析结果路径').fill(logs.join('|'));
    const load = await measure(async () => {
      await page.getByRole('button', { name: '按路径载入' }).click();
      // The overview has no chart; the analysed-result count proves the logs were parsed and rendered.
      await page.waitForFunction(
        (count) => document.querySelector('.metric .metric-value')?.textContent?.startsWith(String(count)),
        logs.length,
        { timeout: 600000 },
      );
      return settle();
    });
    report.scenarios['analysis-load'] = load;
    const tabs = ['定位与连续性', '观测与质控', '模糊度与固定', '大气与状态耦合', '产品覆盖', '结果总览'];
    // Charts render only when scrolled into view, so each tab is measured including its first screen of charts.
    const showTab = async (tab) => {
      await page.getByRole('tab', { name: tab }).click();
      await page.evaluate(() => document.querySelector('.ant-tabs-content-active')?.scrollIntoView());
      return settle();
    };
    for (const tab of tabs) {
      report.scenarios[`analysis-tab:${tab}`] = await measure(() => showTab(tab));
    }
    await showTab('定位与连续性');
    const canvas = page.locator('.ant-tabs-content-active canvas').first();
    await canvas.waitFor();
    const box = await canvas.boundingBox();
    report.scenarios['analysis-zoom'] = await measure(async () => {
      // Shift + wheel zooms the shared time axis, which is the common inspection gesture.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
      await page.keyboard.down('Shift');
      for (let i = 0; i < 6; i++) {
        await page.mouse.wheel(0, -300);
        await page.waitForTimeout(150);
      }
      await page.keyboard.up('Shift');
      return settle();
    });
  }
} finally {
  await removeRealtimeServer().catch(() => {});
  report.errors = errors;
  const file = path.join(outputDir, `${label}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
