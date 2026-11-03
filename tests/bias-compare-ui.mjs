// Browser check of the bias comparison page with a mocked IPC. Needs `pnpm dev --host 127.0.0.1` and Edge.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

await fs.mkdir('runtime/compare-ui-bias', { recursive: true });
await fs.writeFile(
  'runtime/compare-ui-bias/index.html',
  '<html><head><meta charset="UTF-8"></head><body style="background:#10141c;color:#dde5f2;margin:24px"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
);
await fs.writeFile(
  'runtime/compare-ui-bias/main.tsx',
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfigProvider,App,theme} from 'antd';import Compare from '/src/pages/Compare';import '/src/styles.css';
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{algorithm:theme.darkAlgorithm}}><App><Compare/></App></ConfigProvider>);`,
);
const EPOCHS = 48;
const histogram = (spread) => ({
  min: -0.5,
  width: 0.02,
  counts: Array.from({ length: 50 }, (_, i) => Math.round(400 * Math.exp(-((((i - 24.5) * 0.02) / spread) ** 2)))),
});
const wave = (amp) =>
  Array.from({ length: EPOCHS }, (_, k) => (k === 7 ? null : +(amp * (1 + Math.sin(k / 5))).toFixed(4)));
const row = (system, signal, kind, extra = {}) => ({
  system,
  signal,
  kind,
  unit: kind === 'code' || kind === 'dcb' ? 'ns' : 'cyc',
  sats: 30,
  offset: 0.05,
  rms: 0.3,
  max: 0.8,
  temporalStd: 0,
  withinTolerance: null,
  outliers: 1,
  totalRms: extra.rms ?? 0.3,
  epochWithin: kind === 'wl' || kind === 'nl' || kind === 'phase' ? 0.9 : null,
  histogram: histogram(kind === 'code' || kind === 'dcb' ? 0.2 : 0.08),
  series: { rms: wave(0.1), datum: wave(0.2) },
  ...extra,
});
const item = (sat, signal, kind, mean, outlier = false) => ({
  series: kind === 'wl' || kind === 'nl' ? wave(Math.abs(mean) + 0.02) : undefined,
  sat,
  system: sat[0],
  signal,
  kind,
  mean,
  rms: Math.abs(mean) + 0.02,
  temporalStd: 0.003,
  n: 288,
  outlier,
});
const results = [
  {
    name: 'WHU 实时',
    timeSystem: 'G',
    start: '2026-09-19T17:35:00',
    satellites: ['C01', 'C02', 'C06', 'C20', 'C21', 'G01', 'G02', 'G03'],
    excluded: [],
    sign: { code: -1, phase: -1, auto: true, correlation: -0.96 },
    orbitClasses: { C01: 'GEO', C02: 'GEO', C06: 'IGSO', C20: 'MEO', C21: 'MEO', G01: 'MEO', G02: 'MEO', G03: 'MEO' },
    step: 300,
    epochs: EPOCHS,
    rows: [
      row('G', 'C1W', 'code'),
      row('C', 'C1P', 'code', { rms: 23.4, max: 76.6, outliers: 8 }),
      row('G', 'DCB C1W-C2W', 'dcb', { rms: 0.19 }),
      row('G', 'WL L1C-L2L', 'wl', { unit: 'cyc', rms: 0.08, max: 0.13, withinTolerance: 0.78, outliers: 0 }),
      row('G', 'NL L1C', 'nl', { unit: 'cyc', rms: 0.12, max: 0.25, outliers: 3 }),
      row('G', 'L1W', 'phase', { unit: 'cyc', rms: 0.26, max: 0.45, outliers: 0 }),
    ],
    items: [
      item('G01', 'C1W', 'code', 0.12),
      item('G02', 'C1W', 'code', -2.4, true),
      item('G03', 'C1W', 'code', 0.03),
      item('G01', 'WL L1C-L2L', 'wl', 0.04),
      item('G02', 'WL L1C-L2L', 'wl', 0.13),
      item('G01', 'NL L1C', 'nl', 0.1),
    ],
    hints: ['G02 C1W 与参考相差 -2.400 ns，超出同系统中位数 0.100 ns 的 3 倍'],
    testOnly: ['G99'],
    referenceOnly: ['R01'],
  },
];
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript((payload) => {
  window.calls = [];
  // The native drag and drop events of the webview: enter / over / drop with physical positions.
  let id = 0;
  const callbacks = {};
  const listeners = {};
  window.__drop = (paths, x, y) => {
    const emit = (event, body) =>
      (listeners[event] || []).forEach((h) => callbacks[h]({ event, id: 0, payload: body }));
    emit('tauri://drag-enter', { paths, position: { x, y } });
    emit('tauri://drag-over', { position: { x, y } });
    emit('tauri://drag-drop', { paths, position: { x, y } });
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
    transformCallback: (cb) => {
      callbacks[++id] = cb;
      return id;
    },
    unregisterCallback: (h) => delete callbacks[h],
    invoke: async (command, args) => {
      if (command === 'plugin:event|listen') {
        (listeners[args.event] ||= []).push(args.handler);
        return id;
      }
      if (command === 'plugin:event|unlisten') return undefined;
      window.calls.push({ command, ...args });
      if (command === 'compare_biases')
        return {
          results: payload.map((r) => ({
            ...r,
            excluded: (args.request.exclude ?? []).filter((sat) => r.satellites.includes(sat)),
          })),
          failures: [],
        };
      if (command === 'engine_info') return { capabilities: { product_convert: 3 } };
      if (command === 'convert_ssr_products') return { bia: 'D:/out/products.bia', directory: 'D:/out', log: '' };
      throw new Error('unexpected ' + command);
    },
  };
}, results);
await page.goto('http://127.0.0.1:1420/runtime/compare-ui-bias/index.html');
const start = page.getByRole('button', { name: '开始对比' });
// Files dropped on the reference box land there, wherever in the box, including below its last line; dropped beside the
// boxes they are refused with a word. The converter takes files dropped on an input or beside the inputs.
const dropOn = async (locator, paths, where = 'top') => {
  const box = await locator.boundingBox();
  const y = where === 'bottom' ? box.y + box.height - 6 : box.y + 12;
  await page.evaluate(([p, x, yy]) => window.__drop(p, x, yy), [paths, box.x + box.width / 2, y]);
};
await page.getByText('参考产品').first().waitFor();
await page.waitForTimeout(500);
await dropOn(page.locator('[data-role="参考产品"]'), ['D:/b/WUM_a.BIA', 'D:/b/WUM_b.CLK'], 'bottom');
await page.getByText('WUM_a.BIA').waitFor();
await page.getByText('CLK · WUM_b.CLK').waitFor();
await page.getByLabel('参考产品路径').scrollIntoViewIfNeeded();
const gap = await page.locator('[data-role="参考产品"]').boundingBox();
await page.evaluate(([x, y]) => window.__drop(['D:/b/other.BIA'], x, y), [gap.x + gap.width + 8, gap.y + 30]);
await page.getByText('请把文件拖到“参考产品”或某个“对比产品”的框里').waitFor();
const closers = page.locator('[data-role="参考产品"] .ant-tag .anticon-close');
while ((await closers.count()) > 0) await closers.first().click();
await start.waitFor();
assert.equal(await start.isDisabled(), true);

await page.getByLabel('参考产品路径').fill('D:/b/WUM_OSB.BIA|D:/b/notes.txt|D:/b/x.bia.gz');
await page.getByLabel('参考产品添加路径').click();
await page
  .getByText(/是压缩文件/)
  .first()
  .waitFor();
await page.getByText('WUM_OSB.BIA').waitFor();
assert.equal(await start.isDisabled(), true, 'the test product is still empty');
await page.getByLabel('对比产品 1路径').fill('D:/b/COD_OSB.BIA');
await page.getByLabel('对比产品 1添加路径').click();
await page.getByText('COD_OSB.BIA').waitFor();
assert.equal(await start.isDisabled(), false);

// A second product comes from a recorded stream: the engine writes a Bias-SINEX file that joins the product.
await page.getByRole('button', { name: '添加对比产品' }).click();
await page.getByText('从实时录制流生成 Bias-SINEX').nth(1).click();
const generate = page.getByRole('button', { name: '生成并加入' }).last();
assert.equal(await generate.isDisabled(), true, 'needs a stream');
await dropOn(
  page.locator('.stream-converter').last(),
  ['D:/rec/PROD_SSRC00WHU0_x.rtcm3', 'D:/rec/BIAS_OSBC00WHU1_x.rtcm3', 'D:/rec/BRDC_x.rnx'],
  'bottom',
);
await page.getByText('已填入 3 个文件').waitFor();
assert.equal(await page.getByLabel('SSR 流', { exact: true }).last().inputValue(), 'D:/rec/PROD_SSRC00WHU0_x.rtcm3');
assert.equal(await page.getByLabel('偏差流', { exact: true }).last().inputValue(), 'D:/rec/BIAS_OSBC00WHU1_x.rtcm3');
assert.equal(await page.getByLabel('广播星历', { exact: true }).last().inputValue(), 'D:/rec/BRDC_x.rnx');
await dropOn(page.locator('[data-field="广播星历"]').last(), ['D:/rec/other.rnx']);
assert.equal(await page.getByLabel('广播星历', { exact: true }).last().inputValue(), 'D:/rec/other.rnx');
await page.getByLabel('广播星历', { exact: true }).last().fill('');
await page.getByLabel('偏差流', { exact: true }).last().fill('');
await page.getByLabel('SSR 流', { exact: true }).last().fill('D:/rec/ssr.rtcm3');
assert.equal(await generate.isDisabled(), true, 'needs a start time or a RINEX file for the week');
await page.getByLabel('起始时间', { exact: true }).last().fill('2026-09-19');
assert.equal(await generate.isDisabled(), true, 'a partial start time is refused');
await page.getByLabel('起始时间', { exact: true }).last().fill('2026-09-19 17:34:00');
await generate.click();
await page.getByText('已生成 Bias-SINEX，并加入这组产品').waitFor();
await page.getByText('products.bia').waitFor();
const convertCall = await page.evaluate(() => window.calls.find((c) => c.command === 'convert_ssr_products'));
assert.equal(convertCall.request.source, 'ssr');
assert.deepEqual(convertCall.request, {
  kind: 'bias',
  source: 'ssr',
  ssr: 'D:/rec/ssr.rtcm3',
  bias: '',
  navi: '',
  startTime: '2026-09-19 17:34:00',
  name: '对比产品 2',
});
// A Galileo HAS recording carries its own time: no start time or bias stream, only the recording.
await page.getByRole('button', { name: '添加对比产品' }).click();
await page.getByText('从实时录制流生成 Bias-SINEX').nth(2).click();
const hasGroup = page.locator('.stream-converter').last();
await hasGroup.locator('.ant-segmented-item-label', { hasText: 'Galileo HAS' }).click();
assert.equal(await hasGroup.getByLabel('起始时间').count(), 0);
assert.equal(await hasGroup.getByLabel('偏差流').count(), 0);
const hasButton = hasGroup.getByRole('button', { name: '生成并加入' });
assert.equal(await hasButton.isDisabled(), true);
await hasGroup.getByLabel('HAS 记录', { exact: true }).fill('D:/rec/HAS.has');
assert.equal(await hasButton.isDisabled(), false, 'biases of a HAS recording need nothing else');
await hasButton.click();
await page.getByText('已生成 Bias-SINEX，并加入这组产品').last().waitFor();
const hasCall = await page.evaluate(() => window.calls.filter((c) => c.command === 'convert_ssr_products').at(-1));
assert.deepEqual(hasCall.request, {
  kind: 'bias',
  source: 'has',
  ssr: 'D:/rec/HAS.has',
  bias: '',
  navi: '',
  startTime: '',
  name: '对比产品 3',
});
await page.getByLabel('移除对比产品 3').click();
await page.getByLabel('移除对比产品 2').click();
await start.click();
await page.getByText('已完成对比：偏差 1 组').waitFor();
const sent = await page.evaluate(() => window.calls.find((c) => c.command === 'compare_biases'));
assert.deepEqual(sent.request.reference.files, ['D:/b/WUM_OSB.BIA']);
assert.deepEqual(sent.request.tests[0], {
  name: '对比产品 1',
  files: ['D:/b/COD_OSB.BIA'],
  clocks: [],
  orbits: [],
  sign: 'auto',
});
assert.deepEqual(sent.request.exclude, []);

// Overview opens on the wide-lane: a figure per product, the RMS bars and one histogram card per signal.
await page.getByText('需要注意').waitFor();
await page
  .getByText(/G02 C1W 与参考相差/)
  .first()
  .waitFor();
const label = (text) =>
  page.locator('[role="tabpanel"]:visible .ant-segmented-item-label', { hasText: new RegExp('^' + text + '$') });
const cards = () => page.locator('[role="tabpanel"]:visible [data-testid="bias-histogram"]');
await page.getByText('各信号的总体 RMS').waitFor();
assert.equal(await cards().count(), 1);
await page.locator('.bias-tile-note', { hasText: '落在 ±0.1 周内' }).waitFor();
await page.getByText('90%').first().waitFor();
await label('窄巷（NL）').click();
assert.equal(await cards().count(), 1);
await page.getByText(/第一频率相位偏差的小数周/).waitFor();
await label('码偏差').click();
assert.equal(await cards().count(), 2);
await label('相位偏差').click();
await page.getByText(/不同机构之间相差很大是正常的/).waitFor();
await label('宽巷（WL）').click();
for (const canvas of await cards().locator('canvas').all()) assert.ok((await canvas.boundingBox()).height > 100);

// The table is folded away; a row opens the satellites of that signal.
await page.getByText('详细数值表').click();
const rows = page.locator('[role="tabpanel"]:visible .ant-table-tbody > tr:not(.ant-table-measure-row)');
assert.equal(await rows.count(), 1);
await rows.first().click();
await page.getByRole('tab', { name: '各卫星', selected: true }).waitFor();
await page.getByText('每颗卫星随时间的差').waitFor();
await page.getByText('每个历元的 RMS').waitFor();
await page.getByText('扣除的公共基准').waitFor();
// Charts draw only while on screen, so walk down the page to let each one render.
for (const heading of ['每颗卫星随时间的差', '每个历元的 RMS', '扣除的公共基准']) {
  await page.getByText(heading).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
}
const canvasCount = await page.locator('[role="tabpanel"]:visible canvas').count();
assert.ok(canvasCount >= 3, `heat map and the two series, got ${canvasCount}`);
await page.getByText('各卫星数值表').click();
assert.equal(await page.locator('[role="tabpanel"]:visible .ant-table-tbody > tr.product-outlier').count(), 0);
await page.screenshot({ path: 'runtime/compare-ui-bias/satellites.png', fullPage: true });
// A code signal has no heat map, but still the bars and the epoch series.
await page.getByLabel('信号', { exact: true }).click();
await page.getByTitle('GPS · C1W').click();
assert.equal(await page.getByText('每颗卫星随时间的差').count(), 0);
await page.getByText('每个历元的 RMS').waitFor();
assert.equal(await page.locator('[role="tabpanel"]:visible .ant-table-tbody > tr.product-outlier').count(), 1);
// The sign convention was decided from the data; it can be overruled, and an orbit file can be added for the classes.
await page.getByTestId('sign-note').getByText('码和相位偏差已取反（自动判断）').waitFor();
await page.getByLabel('对比产品 1路径').fill('D:/b/orbit.SP3');
await page.getByLabel('对比产品 1添加路径').click();
await page.getByText('SP3 · orbit.SP3').waitFor();
await page.locator('.ant-segmented-item-label', { hasText: /^不取反$/ }).click();
await start.click();
await page.waitForFunction(() => {
  const call = window.calls.filter((c) => c.command === 'compare_biases').at(-1);
  return call.request.tests[0].sign === 'keep' && call.request.tests[0].orbits.join() === 'D:/b/orbit.SP3';
});

// Satellite selection: one click for the flagged ones, a typed range, a BeiDou generation, a single chip, and back.
const compareCalls = () => page.evaluate(() => window.calls.filter((c) => c.command === 'compare_biases'));
const lastExclude = async () => (await compareCalls()).at(-1).request.exclude;
const expectExclude = (list) =>
  page.waitForFunction(
    (want) =>
      window.calls
        .filter((c) => c.command === 'compare_biases')
        .at(-1)
        .request.exclude.join() === want,
    list.join(),
  );
await page.getByText('卫星筛选').scrollIntoViewIfNeeded();
await page.getByText('卫星筛选').click();
await page.getByTestId('satellite-summary').getByText('参与统计 8 / 8 颗').waitFor();
await page.getByRole('button', { name: '剔除标红的异常卫星（1）' }).click();
await expectExclude(['G02']);
await page.getByTestId('satellite-summary').getByText('参与统计 7 / 8 颗').waitFor();
await page.getByText('下面的统计已剔除 1 颗卫星：G02').waitFor();
await page.getByLabel('按范围选择卫星').fill('C01-C06 X99');
await page.getByRole('button', { name: /^剔\s?除$/ }).click();
await page.getByText('没有这些卫星：X99').waitFor();
await expectExclude(['C01', 'C02', 'C06', 'G02']);
await page.getByRole('button', { name: '恢复BDS-2' }).click();
await expectExclude(['G02']);
await page.getByRole('button', { name: '剔除BDS-3' }).click();
await expectExclude(['C20', 'C21', 'G02']);
assert.equal(await page.getByRole('button', { name: 'C20', exact: true }).getAttribute('aria-pressed'), 'false');
assert.equal(await page.getByRole('button', { name: 'C01', exact: true }).getAttribute('aria-pressed'), 'true');
await page.getByRole('button', { name: 'C01', exact: true }).click();
await page.getByRole('button', { name: 'C06', exact: true }).click({ modifiers: ['Shift'] });
await expectExclude(['C01', 'C02', 'C06', 'C20', 'C21', 'G02']);
await page.getByRole('button', { name: '恢复全部' }).click();
await expectExclude([]);
// Orbit types come from the orbit files: one button per class, restoring when all of it is already out.
await page.getByRole('button', { name: '剔除GEO' }).click();
await expectExclude(['C01', 'C02']);
await page.getByRole('button', { name: '剔除IGSO' }).click();
await expectExclude(['C01', 'C02', 'C06']);
await page.getByRole('button', { name: '恢复GEO' }).click();
await expectExclude(['C06']);
await page.getByRole('button', { name: '恢复全部' }).click();
await expectExclude([]);
await page.getByText('下面的统计已剔除').waitFor({ state: 'detached' });
assert.deepEqual(await lastExclude(), []);

await page.getByRole('tab', { name: '覆盖情况' }).click();
await page.getByText(/只在对比产品中：G99/).waitFor();
await page.getByText(/参考中有、对比产品缺少：R01/).waitFor();
await page.getByRole('tab', { name: '总览' }).click();
await page.getByText('各信号的总体 RMS').waitFor();
await page.screenshot({ path: 'runtime/compare-ui-bias/result.png', fullPage: true });
assert.deepEqual(errors, []);
await browser.close();
console.log('bias compare UI ok');
