// Browser check of the product comparison page with a mocked IPC. Needs `pnpm dev --host 127.0.0.1` and Edge.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

await fs.mkdir('runtime/compare-ui-orbit', { recursive: true });
await fs.writeFile(
  'runtime/compare-ui-orbit/index.html',
  '<html><head><meta charset="UTF-8"></head><body style="background:#10141c;color:#dde5f2;margin:24px"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
);
await fs.writeFile(
  'runtime/compare-ui-orbit/main.tsx',
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfigProvider,App,theme} from 'antd';import Compare from '/src/pages/Compare';import '/src/styles.css';
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{algorithm:theme.darkAlgorithm}}><App><Compare/></App></ConfigProvider>);`,
);
const moments = (rms, mean = 0) => ({ mean, rms, std: rms * 0.9, max: rms * 2.5, n: 6 });
const satellite = (sat, d3, extra = {}) => ({
  sat,
  system: sat[0],
  r: moments(d3 / 3),
  a: moments(d3 / 2),
  c: moments(d3 / 3),
  d3: moments(d3),
  clock: moments(0.03),
  clockJumps: 0,
  sisre: 0.03,
  coverage: 1,
  outlier: false,
  rSeries: [0.01, 0.02, null, 0.015],
  aSeries: [0.02, 0.01, 0, 0.01],
  cSeries: [0, 0.01, 0.01, 0],
  clockSeries: [0.1, 0.12, 0.1, null],
  ...extra,
});
const t0 = Date.parse('2026-09-19T17:35:00Z');
const fixture = [
  {
    name: 'WHU 实时',
    timeSystem: 'GPS',
    epochs: [0, 1, 2, 3].map((k) => t0 + k * 300_000),
    stepSeconds: 300,
    systems: [
      {
        system: 'G',
        sats: 30,
        orbitEpochs: 4230,
        d3Median: 0.0331,
        rMedian: 0.0108,
        aMedian: 0.0246,
        cMedian: 0.0195,
        d3Rms: 0.0548,
        rMean: 0,
        clockStdMedian: 0.0264,
        sisreMedian: 0.0236,
        coverage: 1,
      },
      {
        system: 'C',
        sats: 29,
        orbitEpochs: 4089,
        d3Median: 0.0479,
        rMedian: 0.0151,
        aMedian: 0.0323,
        cMedian: 0.0295,
        d3Rms: 0.0689,
        rMean: 0,
        clockStdMedian: 0.0531,
        sisreMedian: 0.0437,
        coverage: 1,
      },
    ],
    satellites: [
      satellite('G01', 0.03),
      satellite('G31', 0.233, { outlier: true }),
      satellite('C07', 0.158, { outlier: true, clockJumps: 2 }),
    ],
    hourly: [
      { system: 'G', time: t0, d3Rms: 0.03 },
      { system: 'G', time: t0 + 3_600_000, d3Rms: 0.04 },
    ],
    hints: ['G31 轨道三维 RMS 23.3 cm，是 G 系统中位数 3.3 cm 的 7.0 倍'],
    candidates: ['C07', 'G01', 'G31'],
    excluded: [],
    orbitClasses: { C07: 'IGSO', G01: 'MEO', G31: 'MEO' },
    apc: false,
    testOnly: [],
    referenceOnly: ['G01'],
  },
  {
    name: 'CHC 实时',
    timeSystem: 'GPS',
    epochs: [0, 1, 2, 3].map((k) => t0 + k * 300_000),
    stepSeconds: 300,
    systems: [
      {
        system: 'G',
        sats: 30,
        orbitEpochs: 4000,
        d3Median: 0.05,
        rMedian: 0.02,
        aMedian: 0.03,
        cMedian: 0.02,
        d3Rms: 0.06,
        rMean: 0,
        clockStdMedian: 0.03,
        sisreMedian: 0.03,
        coverage: 0.98,
      },
    ],
    satellites: [satellite('G01', 0.05)],
    hourly: [{ system: 'G', time: t0, d3Rms: 0.05 }],
    hints: [],
    candidates: ['G01'],
    excluded: [],
    orbitClasses: { G01: 'MEO' },
    apc: false,
    testOnly: [],
    referenceOnly: [],
  },
];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript((results) => {
  window.calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.calls.push({ command, ...args });
      if (command === 'compare_products')
        return {
          results: results.map((r) => ({
            ...r,
            excluded: (args.request.exclude ?? []).filter((sat) => r.candidates.includes(sat)),
          })),
          failures: [],
        };
      if (command === 'engine_info') return { capabilities: { product_convert: 3 } };
      if (command === 'convert_ssr_products')
        return { sp3: 'D:/out/products.sp3', clk: 'D:/out/products.clk', directory: 'D:/out', log: '' };
      throw new Error('unexpected ' + command);
    },
  };
}, fixture);
await page.goto('http://127.0.0.1:1420/runtime/compare-ui-orbit/index.html');
const start = page.getByRole('button', { name: '开始对比' });
await start.waitFor();
assert.equal(await start.isDisabled(), true, 'nothing to compare yet');

// Paths are added by typing; compressed and unknown files are refused with a message.
await page.getByLabel('参考产品路径').fill('D:/p/ref_ORB.SP3|D:/p/ref_CLK.CLK|D:/p/other.txt|D:/p/x.sp3.gz');
await page.getByLabel('参考产品添加路径').click();
await page
  .getByText(/是压缩文件/)
  .first()
  .waitFor();
await page.getByText('SP3 · ref_ORB.SP3').waitFor();
await page.getByText('CLK · ref_CLK.CLK').waitFor();
assert.equal(await start.isDisabled(), true, 'test product still empty');
await page.getByLabel('对比产品 1路径').fill('D:/p/whu.sp3|D:/p/whu.clk');
await page.getByLabel('对比产品 1添加路径').click();
await page.getByRole('button', { name: '添加对比产品' }).click();
// Product 2 comes from a recorded stream: the engine writes SP3 / CLK and they join the product.
const converter = page.getByText('从实时录制流生成 SP3 / CLK').nth(1);
await converter.click();
const generate = page.getByRole('button', { name: '生成并加入' }).last();
assert.equal(await generate.isDisabled(), true, 'needs both inputs');
await page.getByLabel('SSR 流', { exact: true }).last().fill('D:/rec/ssr.rtcm3');
await page.getByLabel('广播星历', { exact: true }).last().fill('D:/rec/eph.rtcm3');
await page.getByLabel('起始时间', { exact: true }).last().fill('2026-10-18');
assert.equal(await generate.isDisabled(), true, 'a partial start time is refused');
await page.getByLabel('起始时间', { exact: true }).last().fill('2026-10-18 09:58:00');
await generate.click();
await page.getByText('已生成 SP3 / CLK，并加入这组产品').waitFor();
await page.getByText('SP3 · products.sp3').waitFor();
await page.getByText('CLK · products.clk').waitFor();
const convertCall = await page.evaluate(() => window.calls.find((c) => c.command === 'convert_ssr_products'));
assert.deepEqual(convertCall.request, {
  kind: 'orbit',
  source: 'ssr',
  ssr: 'D:/rec/ssr.rtcm3',
  bias: '',
  navi: 'D:/rec/eph.rtcm3',
  startTime: '2026-10-18 09:58:00',
  name: '对比产品 2',
});
await page.getByLabel('对比产品 1名称').fill('WHU 实时');
await page.getByLabel('对比产品 2名称').fill('CHC 实时');
assert.equal(await start.isDisabled(), false);
await start.click();
await page.getByText('已完成对比：轨道钟差 2 组').waitFor();

const sent = await page.evaluate(() => window.calls.find((c) => c.command === 'compare_products'));
assert.deepEqual(sent.request.reference.sp3, ['D:/p/ref_ORB.SP3']);
assert.deepEqual(sent.request.reference.clk, ['D:/p/ref_CLK.CLK']);
assert.equal(sent.request.tests.length, 2);
assert.deepEqual(sent.request.tests[0], { name: 'WHU 实时', sp3: ['D:/p/whu.sp3'], clk: ['D:/p/whu.clk'], apc: false });
assert.deepEqual(sent.request.tests[1].sp3, ['D:/out/products.sp3']);
assert.deepEqual(sent.request.tests[1].clk, ['D:/out/products.clk']);

// Overview: one row per product and constellation, with the hint above.
await page.getByText('需要注意').waitFor();
await page
  .getByText(/G31 轨道三维 RMS 23.3 cm/)
  .first()
  .waitFor();
assert.equal(await page.locator('[role="tabpanel"]:visible .ant-table-tbody > tr').count(), 3);
await page.getByText('3.3', { exact: true }).first().waitFor();

// Satellites: outliers listed first, a row click opens the time series of that satellite.
await page.getByRole('tab', { name: '各卫星' }).click();
await page.locator('[role="tabpanel"]:visible .ant-table-tbody tr').first().waitFor();
// The histogram can show other metrics, including the clock, and keeps one bar group per product.
for (const metric of ['径向 RMS', '切向 RMS', '法向 RMS', '钟差标准差', 'SISRE', '径向平均偏差', '三维 RMS']) {
  await page
    .locator('[role="tabpanel"]:visible .ant-segmented-item-label', { hasText: new RegExp('^' + metric + '$') })
    .click();
  await page.locator('[role="tabpanel"]:visible canvas').first().waitFor();
}
await page.getByText('下表显示：').waitFor();
assert.equal(await page.locator('[role="tabpanel"]:visible .ant-table-tbody > tr.product-outlier').count(), 2);
await page.locator('[role="tabpanel"]:visible .ant-table-tbody > tr', { hasText: 'C07' }).click();
await page.getByRole('tab', { name: '时间序列', selected: true }).waitFor();
await page.locator('[role="tabpanel"]:visible canvas').first().waitFor();
await page.getByText('钟差（去公共偏移）').click();
await page.getByRole('tab', { name: '分时统计' }).click();
await page.locator('[role="tabpanel"]:visible canvas').first().waitFor();
await page.getByRole('tab', { name: '覆盖情况' }).click();
await page.getByText(/参考中有、对比产品缺少：G01/).waitFor();
// A HAS / B2b product refers to the antenna phase centre: one tick sends it with the comparison.
await page.getByLabel('对比产品 1轨道为天线相位中心').check();
await start.click();
await page.waitForFunction(() => {
  const call = window.calls.filter((c) => c.command === 'compare_products').at(-1);
  return call.request.tests[0].apc === true && !call.request.tests[1].apc;
});
await page.getByLabel('对比产品 1轨道为天线相位中心').uncheck();

// Satellite selection: the flagged satellites in one click, then everything back; each change recomputes.
const expectExclude = (list) =>
  page.waitForFunction(
    (want) =>
      window.calls
        .filter((c) => c.command === 'compare_products')
        .at(-1)
        .request.exclude.join() === want,
    list.join(),
  );
assert.deepEqual(sent.request.exclude, []);
await page.getByText('卫星筛选').scrollIntoViewIfNeeded();
await page.getByText('卫星筛选').click();
await page.getByTestId('satellite-summary').getByText('参与统计 3 / 3 颗').waitFor();
await page.getByRole('button', { name: '剔除标红的异常卫星（2）' }).click();
await expectExclude(['C07', 'G31']);
await page.getByTestId('satellite-summary').getByText('参与统计 1 / 3 颗').waitFor();
await page.getByText('下面的统计已剔除 2 颗卫星：C07 G31').waitFor();
await page.getByRole('button', { name: '恢复全部' }).click();
await expectExclude([]);
await page.getByText('下面的统计已剔除').waitFor({ state: 'detached' });
await page.getByRole('tab', { name: '总览' }).click();
await page.screenshot({ path: 'runtime/compare-ui-orbit/result.png', fullPage: true });
assert.deepEqual(errors, []);
await browser.close();
console.log('product compare UI ok');
