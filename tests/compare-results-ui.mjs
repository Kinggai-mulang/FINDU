// Replay actual desktop results; pass the JSON saved by the matched-product desktop test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const fixture = JSON.parse(
  await fs.readFile(process.argv[2] ?? 'runtime/matched-products-ui/native-results.json', 'utf8'),
);
const folder = 'runtime/compare-results-ui';
await fs.mkdir(folder, { recursive: true });
await fs.writeFile(
  `${folder}/index.html`,
  '<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./main.tsx"></script></html>',
);
await fs.writeFile(
  `${folder}/main.tsx`,
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfigProvider,App} from 'antd';import Compare from '/src/pages/Compare';import {antdThemeConfig} from '/src/theme';import '/src/styles.css';createRoot(document.getElementById('root')!).render(<ConfigProvider theme={antdThemeConfig}><App><Compare/></App></ConfigProvider>);`,
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('pageerror:', e.message);
  });
  await page.addInitScript((data) => {
    window.localStorage.setItem('findyou.compareInputs', JSON.stringify(data.inputs));
    window.failBias = 0;
    window.hold = false;
    window.releases = [];
    window.exports = [];
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        if (command.startsWith('plugin:event|')) return 1;
        if (command === 'engine_info') return { capabilities: { product_convert: 3 } };
        if (command === 'runtime_paths') return { root: 'D:/test' };
        if (command === 'plugin:dialog|save') return 'D:/test/export.csv';
        if (command === 'plugin:fs|write_text_file') {
          window.exports.push(args);
          return;
        }
        if (command === 'compare_products' || command === 'compare_biases') {
          const result = structuredClone(command === 'compare_products' ? data.orbits : data.biases);
          if (command === 'compare_biases' && window.failBias) {
            result.failures = result.results
              .slice(0, window.failBias)
              .map((r) => ({ name: r.name, error: '测试：无共同偏差历元' }));
            result.results = result.results.slice(window.failBias);
          }
          if (window.hold) await new Promise((resolve) => window.releases.push(resolve));
          return result;
        }
        throw Error('Unexpected command: ' + command);
      },
    };
  }, fixture);
  await page.goto(`http://127.0.0.1:1420/${folder}/index.html`);
  const run = page.getByRole('button', { name: /开始对比/ });
  const resultTag = page.getByText('轨道钟差 4 组 · 偏差 4 组', { exact: true });
  await run.click();
  await resultTag.waitFor();
  await page.getByRole('tab', { name: '各卫星', exact: true }).click();
  const systems = page.locator('[aria-label="系统筛选"]');
  await systems.getByText('北斗', { exact: true }).click();
  await page.locator('[aria-label="对比产品"]').getByText('B2B', { exact: true }).click();
  assert.ok(await systems.getByText('北斗', { exact: true }).isVisible());
  await page.getByText('B2B 在北斗下没有可比卫星', { exact: true }).waitFor();
  await systems.getByText('GPS', { exact: true }).click();
  assert.ok(await page.locator('.ant-table-row').count());
  await page.locator('[aria-label="对比内容"]').getByText('偏差', { exact: true }).click();
  assert.equal(await page.getByTestId('bias-tile').count(), 4);
  await page
    .getByTestId('bias-tile')
    .filter({ hasText: 'HAS' })
    .getByText(/无可比/)
    .waitFor();
  await page.getByRole('button', { name: '导出 CSV' }).click();
  await page.waitForFunction(() => window.exports.length === 1);
  await page.getByLabel('对比产品 1名称', { exact: true }).fill('edited');
  assert.equal(await resultTag.count(), 0);
  assert.ok(await page.getByRole('button', { name: '导出 CSV' }).isDisabled());
  await page.getByLabel('对比产品 1名称', { exact: true }).fill('WHU');
  await page.evaluate(() => {
    window.failBias = 1;
  });
  await run.click();
  await page.getByText('轨道钟差 4 组 · 偏差 3 组', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-role="对比产品 1"] [data-testid="sign-note"]').count(), 0);
  assert.match(await page.locator('[data-role="对比产品 2"] [data-testid="sign-note"]').innerText(), /取反/);
  await page.evaluate(() => {
    window.failBias = 4;
  });
  await run.click();
  await page.getByRole('columnheader', { name: '参考匹配率' }).waitFor();
  assert.equal(await page.locator('[aria-label="对比内容"]').count(), 0);
  await page.evaluate(() => {
    window.failBias = 0;
    window.hold = true;
  });
  await run.click();
  await page.waitForFunction(() => window.releases.length === 2);
  await page.getByLabel('对比产品 1名称', { exact: true }).fill('changed during request');
  await page.evaluate(() => {
    window.releases.forEach((r) => r());
    window.hold = false;
  });
  await page.waitForTimeout(200);
  assert.equal(await resultTag.count(), 0, 'old request cannot restore results for changed inputs');
  assert.ok(await page.getByRole('button', { name: '导出 CSV' }).isDisabled());
  await page.getByLabel('对比产品 1名称', { exact: true }).fill('WHU');
  await run.click();
  await resultTag.waitFor();
  await page.getByRole('tab', { name: '总览', exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${folder}/passed.png` });
  assert.deepEqual(errors, []);
  console.log(
    'System selection, unavailable biases, partial failure identity, section fallback, stale/in-flight results and CSV passed',
  );
} finally {
  await browser.close();
}
