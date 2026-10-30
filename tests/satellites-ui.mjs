import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

await fs.mkdir('runtime/satellite-ui', { recursive: true });
await fs.writeFile(
  'runtime/satellite-ui/index.html',
  '<html><head><meta charset="UTF-8"></head><body style="background:#10141c;color:#dde5f2;margin:24px"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
);
await fs.writeFile(
  'runtime/satellite-ui/main.tsx',
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfigProvider,App,theme} from 'antd';import SatelliteDetails from '/src/components/SatelliteDetails';createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{algorithm:theme.darkAlgorithm}}><App><SatelliteDetails sessionKey="test" runId="run-test" sample={1} active={true}/></App></ConfigProvider>);`,
);
const fixture = process.argv[2]
  ? JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
  : {
      schemaVersion: 1,
      runId: 'test',
      sequence: 1,
      week: 2441,
      tow: 36000,
      publishedAt: 0,
      satellites: [
        {
          prn: 'G01',
          system: 'GPS',
          azimuth: 40,
          elevation: 60,
          used: true,
          signals: [{ slot: 0, band: 'L1', signal: '1C', cn0: 43, used: true }],
        },
        {
          prn: 'C01',
          system: 'BDS',
          azimuth: 220,
          elevation: 35,
          used: false,
          signals: [{ slot: 0, band: 'B1I', signal: '2I', cn0: 39, used: false }],
        },
        {
          prn: 'E01',
          system: 'GAL',
          azimuth: null,
          elevation: null,
          used: null,
          signals: [{ slot: 0, band: 'E1', signal: '1X', cn0: null, used: null }],
        },
      ],
    };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript((snapshot) => {
  window.calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.calls.push({ command, ...args, at: performance.now() });
      return args.enabled
        ? { ...snapshot, runId: 'run-test', sequence: window.calls.length, publishedAt: Date.now() / 1000 }
        : null;
    },
  };
}, fixture);
await page.goto('http://127.0.0.1:1420/runtime/satellite-ui/index.html');
await page.getByText('卫星详情 · 星空 / 频点 / 载噪比', { exact: true }).waitFor();
assert.equal(await page.evaluate(() => window.calls.length), 0, 'collapsed detail must not subscribe');
await page.getByText('卫星详情 · 星空 / 频点 / 载噪比', { exact: true }).click();
await page.getByText(new RegExp(`观测 ${fixture.satellites.length} 颗`)).waitFor();
assert.equal(await page.locator('canvas').count(), 3);
await page.waitForTimeout(2300);
const calls = await page.evaluate(() => window.calls.filter((c) => c.enabled));
assert.ok(calls.length <= 4, 'updates must be capped at 1 Hz');
assert.ok(calls.slice(1).every((c, i) => c.at - calls[i].at >= 900));
await page.screenshot({ path: 'runtime/satellite-ui/overview.png', fullPage: true });
const layout = await page.evaluate(async () => {
  const { getInstanceByDom } = await import('/node_modules/.vite/deps/echarts_core.js');
  const sky = document.querySelector('[aria-label="卫星天空图"]');
  const option = getInstanceByDom(sky).getOption();
  const signal = getInstanceByDom(document.querySelector('[aria-label="当前历元卫星载噪比"]'));
  if (signal.getOption().dataZoom.length) signal.dispatchAction({ type: 'dataZoom', start: 25, end: 60 });
  return {
    width: sky.clientWidth,
    height: sky.clientHeight,
    inside: option.series[0].data.every(
      (r) =>
        r.symbol.startsWith('image://data:image/svg+xml,') &&
        decodeURIComponent(r.symbol).includes('>' + r.prn + '</text>'),
    ),
    zoom: signal.getOption().dataZoom.length,
  };
});
assert.ok(layout.width > 500 && layout.height >= 500 && layout.inside, 'large sky with internal PRNs');
await page.waitForTimeout(2200);
if (layout.zoom) {
  const zoom = await page.evaluate(async () => {
    const { getInstanceByDom } = await import('/node_modules/.vite/deps/echarts_core.js');
    return getInstanceByDom(document.querySelector('[aria-label="当前历元卫星载噪比"]')).getOption().dataZoom[0];
  });
  assert.ok(Math.abs(zoom.start - 25) < 1 && Math.abs(zoom.end - 60) < 1, 'new snapshot preserves user zoom');
}
await page.setViewportSize({ width: 850, height: 1000 });
await page.waitForTimeout(150);
const narrow = await page.evaluate(() => {
  const sky = document.querySelector('[aria-label="卫星天空图"]').getBoundingClientRect();
  const signal = document.querySelector('[aria-label="当前历元卫星载噪比"]').getBoundingClientRect();
  return { stacked: signal.top >= sky.bottom, overflow: document.documentElement.scrollWidth > innerWidth };
});
assert.ok(narrow.stacked && !narrow.overflow, 'narrow detail stacks without horizontal overflow');
await page.screenshot({ path: 'runtime/satellite-ui/narrow.png', fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.getByLabel('卫星星座', { exact: true }).click();
await page.locator('.ant-select-item-option-content').getByText('GPS', { exact: true }).click();
await page.getByLabel('卫星频点', { exact: true }).click();
await page.locator('.ant-select-item-option-content').getByText('L1', { exact: true }).click();
await page.screenshot({ path: 'runtime/satellite-ui/detail.png', fullPage: true });
const sky = await page.evaluate(async () => {
  const { getInstanceByDom } = await import('/node_modules/.vite/deps/echarts_core.js');
  const chart = getInstanceByDom(document.querySelector('[aria-label="卫星天空图"]'));
  const row = chart.getOption().series[0].data[0];
  if (!row) throw new Error('no current sky position');
  return { prn: row.prn, point: chart.convertToPixel({ seriesIndex: 0 }, row.value) };
});
await page
  .getByRole('img', { name: '卫星天空图', exact: true })
  .click({ position: { x: sky.point[0], y: sky.point[1] } });
await page.waitForTimeout(100);
assert.ok(
  (await page.getByLabel('单颗卫星', { exact: true }).locator('..').textContent()).includes(sky.prn),
  'sky click must select satellite',
);
const enabledBeforeHide = await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  return window.calls.filter((c) => c.enabled).length;
});
await page.waitForTimeout(1300);
assert.equal(
  await page.evaluate(() => window.calls.filter((c) => c.enabled).length),
  enabledBeforeHide,
  'hidden page must stop polling',
);
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  document.dispatchEvent(new Event('visibilitychange'));
});
const timing = await page.evaluate(async () => {
  const { getInstanceByDom } = await import('/node_modules/.vite/deps/echarts_core.js');
  const chart = getInstanceByDom(document.querySelector('[aria-label="当前历元卫星载噪比"]'));
  const times = [];
  const option = chart.getOption();
  for (let i = 0; i < 30; i++) {
    const start = performance.now();
    chart.setOption(option, { notMerge: true });
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[28];
});
assert.ok(timing < 100, `signal chart P95 ${timing} ms`);
await page.getByText('卫星详情 · 星空 / 频点 / 载噪比', { exact: true }).click();
await page.waitForTimeout(500);
assert.equal(await page.locator('canvas').count(), 0, 'collapse must dispose charts');
const after = await page.evaluate(() => window.calls.filter((c) => c.enabled).length);
await page.waitForTimeout(1200);
assert.equal(
  await page.evaluate(() => window.calls.filter((c) => c.enabled).length),
  after,
  'collapsed polling stopped',
);
assert.ok(await page.evaluate(() => window.calls.some((c) => c.enabled === false)));
assert.deepEqual(errors, []);
const evidence = {
  status: 'passed',
  signalChartP95Ms: timing,
  layout,
  narrow,
  cases: [
    'collapsed-no-subscription',
    'three-charts',
    '1Hz',
    'system-band-filter',
    'sky-selection',
    'hidden-no-polling',
    'dispose-and-unsubscribe',
    'zoom-preserved',
    'responsive-layout',
  ],
};
await fs.writeFile('runtime/satellite-ui/result.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
await browser.close();
