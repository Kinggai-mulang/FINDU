// Browser check of products with mixed files: BIA, CLK and SP3 dropped together are all used, each comparison runs for
// the products that have what it needs, and what cannot be compared is named without stopping the rest.
// Needs `pnpm dev --host 127.0.0.1` and Edge.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

await fs.mkdir('runtime/compare-ui-shared', { recursive: true });
await fs.writeFile(
  'runtime/compare-ui-shared/index.html',
  '<html><head><meta charset="UTF-8"></head><body style="background:#10141c;color:#dde5f2;margin:24px"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
);
await fs.writeFile(
  'runtime/compare-ui-shared/main.tsx',
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfigProvider,App,theme} from 'antd';import Compare from '/src/pages/Compare';import '/src/styles.css';
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{algorithm:theme.darkAlgorithm}}><App><Compare/></App></ConfigProvider>);`,
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 1100 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript(() => {
  window.calls = [];
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
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
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
      if (command === 'compare_products' || command === 'compare_biases')
        return {
          results: [],
          failures: window.failing ? [{ name: '对比产品 1', error: '两份产品覆盖的时间没有重叠' }] : [],
        };
      if (command === 'engine_info') return { capabilities: { product_convert: 3 } };
      throw new Error('unexpected ' + command);
    },
  };
});
await page.goto('http://127.0.0.1:1420/runtime/compare-ui-shared/index.html');
const dropOn = async (locator, paths) => {
  const box = await locator.boundingBox();
  await page.evaluate(([p, x, y]) => window.__drop(p, x, y), [paths, box.x + box.width / 2, box.y + 12]);
};
const start = page.getByRole('button', { name: '开始对比' });
const callsOf = (command) => page.evaluate((c) => window.calls.filter((x) => x.command === c), command);
const note = page.getByTestId('input-note');
await start.waitFor();
await page.waitForTimeout(500);

// One drop of all three kinds into the reference and into product 1.
await dropOn(page.locator('[data-role="参考产品"]'), ['D:/r/ref_OSB.BIA', 'D:/r/ref_CLK.CLK', 'D:/r/ref_ORB.SP3']);
await page.getByText('BIA · ref_OSB.BIA').waitFor();
await page.getByText('CLK · ref_CLK.CLK').waitFor();
await page.getByText('SP3 · ref_ORB.SP3').waitFor();
assert.equal(await start.isDisabled(), true, 'no test product yet');
await note.filter({ hasText: '还没有带 SP3 轨道文件的对比产品' }).waitFor();
await note.filter({ hasText: '还没有带 BIA 偏差文件的对比产品' }).waitFor();
await dropOn(page.locator('[data-role="对比产品 1"]'), ['D:/t/whu.sp3', 'D:/t/whu.bia', 'D:/t/whu.clk']);
await page.getByText('BIA · whu.bia').waitFor();
assert.equal(await start.isDisabled(), false);

// Product 2 has only biases, product 3 only orbit and clock: each is left out of the comparison it cannot be in.
await page.getByRole('button', { name: '添加对比产品' }).click();
await dropOn(page.locator('[data-role="对比产品 2"]'), ['D:/t/cod.BIA']);
await page.getByRole('button', { name: '添加对比产品' }).click();
await dropOn(page.locator('[data-role="对比产品 3"]'), ['D:/t/chc.sp3', 'D:/t/chc.clk']);
await page.getByText('SP3 · chc.sp3').waitFor();
await note.filter({ hasText: '对比产品 2 没有 SP3 轨道文件，轨道和钟差不比较它' }).waitFor();
await note.filter({ hasText: '对比产品 3 没有 BIA 偏差文件，偏差不比较它' }).waitFor();
await start.click();
await page.getByText('已完成对比：轨道钟差 0 组、偏差 0 组').waitFor();
const orbit = (await callsOf('compare_products')).at(-1);
assert.deepEqual(orbit.request.reference, {
  name: '参考产品',
  sp3: ['D:/r/ref_ORB.SP3'],
  clk: ['D:/r/ref_CLK.CLK'],
  apc: false,
});
assert.deepEqual(
  orbit.request.tests.map((t) => [t.name, t.sp3]),
  [
    ['对比产品 1', ['D:/t/whu.sp3']],
    ['对比产品 3', ['D:/t/chc.sp3']],
  ],
);
const bias = (await callsOf('compare_biases')).at(-1);
assert.deepEqual(bias.request.reference, {
  name: '参考产品',
  files: ['D:/r/ref_OSB.BIA'],
  clocks: ['D:/r/ref_CLK.CLK'],
  orbits: ['D:/r/ref_ORB.SP3'],
  sign: 'auto',
});
assert.deepEqual(
  bias.request.tests.map((t) => [t.name, t.files]),
  [
    ['对比产品 1', ['D:/t/whu.bia']],
    ['对比产品 2', ['D:/t/cod.BIA']],
  ],
);

// A product that fails is named with its reason; it does not turn the comparison into an error.
await page.evaluate(() => (window.failing = true));
await start.click();
await page.getByText(/有 2 项没能对比/).waitFor();
await page.getByText('偏差：对比产品 1：两份产品覆盖的时间没有重叠').waitFor();
assert.equal(await page.getByText('对比失败').count(), 0);
await page.evaluate(() => (window.failing = false));

// Without bias files in the reference only the orbit and clock comparison runs; the button stays usable.
const before = (await callsOf('compare_biases')).length;
await page.locator('[data-role="参考产品"] .ant-tag', { hasText: 'BIA ·' }).locator('.anticon-close').click();
await note.filter({ hasText: '偏差不比较：参考产品里还没有 BIA 偏差文件' }).waitFor();
assert.equal(await start.isDisabled(), false);
await start.click();
await page.getByText(/已完成对比：轨道钟差 0 组$/).waitFor();
assert.equal((await callsOf('compare_biases')).length, before, 'no bias comparison without a reference bias file');

// Two drops that are still being read when the second arrives keep both: the second must not undo the first.
const refBox = await page.locator('[data-role="参考产品"]').boundingBox();
const oneBox = await page.locator('[data-role="对比产品 1"]').boundingBox();
await page.evaluate(
  ([r, t]) => {
    window.__drop(['D:/r/late.CLK'], r.x + r.width / 2, r.y + 12);
    window.__drop(['D:/t/late.CLK'], t.x + t.width / 2, t.y + 12);
  },
  [refBox, oneBox],
);
await page.locator('[data-role="参考产品"]').getByText('CLK · late.CLK').waitFor();
await page.locator('[data-role="对比产品 1"]').getByText('CLK · late.CLK').waitFor();
await page.locator('[data-role="参考产品"]').getByText('SP3 · ref_ORB.SP3').waitFor();

// The inputs survive a reload.
await page.reload();
await page.getByText('SP3 · ref_ORB.SP3').waitFor();
await page.getByText('CLK · whu.clk').waitFor();

assert.deepEqual(errors, []);
await browser.close();
console.log('shared inputs UI ok');
