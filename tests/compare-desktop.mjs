// Desktop check of the product comparison with real files: folders are dropped with the native drag-and-drop event, so
// the Rust side lists them, and both comparisons run on the real backend.
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9298'; .\FINDU.exe
//   node tests/compare-desktop.mjs --data <FINDU-test-data>
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, value, i, all) => (value.startsWith('--') ? [...pairs, [value.slice(2), all[i + 1]]] : pairs), []),
);
const data = args.data;
assert.ok(data, '--data <FINDU-test-data folder> is required');
const endpoint = process.env.FINDYOU_CDP ?? 'http://127.0.0.1:9298';
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
await page.setViewportSize({ width: 1500, height: 1100 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

/** The native drop event, emitted through the event plugin to the listeners the app registered. */
const drop = async (locator, paths) => {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  const ratio = await page.evaluate(() => window.devicePixelRatio || 1);
  await page.evaluate(
    async ([p, x, y]) => {
      const emit = (event, payload) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event, payload });
      await emit('tauri://drag-enter', { paths: p, position: { x, y } });
      await emit('tauri://drag-over', { position: { x, y } });
      await emit('tauri://drag-drop', { paths: p, position: { x, y } });
    },
    [paths, (box.x + box.width / 2) * ratio, (box.y + 14) * ratio],
  );
};
const box = (role) => page.locator(`[data-role="${role}"]`);
const tags = (role) => box(role).locator('.ant-tag').allInnerTexts();
const kinds = async (role) => (await tags(role)).map((t) => t.split(' · ')[0]).sort();
const path = (...parts) => [data, ...parts].join('\\');

await page.getByRole('button', { name: /产品对比/ }).click();
await page.getByRole('button', { name: '开始对比' }).waitFor();
// start from nothing: the inputs are remembered between runs
for (const closers of [page.locator('[data-role="参考产品"] .ant-tag .anticon-close')]) {
  while ((await closers.count()) > 0) await closers.first().click();
}
while ((await page.getByRole('button', { name: /移除对比产品/ }).count()) > 0)
  await page
    .getByRole('button', { name: /移除对比产品/ })
    .last()
    .click();
const first = page.locator('[data-role="对比产品 1"] .ant-tag .anticon-close');
while ((await first.count()) > 0) await first.first().click();

// the whole reference folder: six days of BIA, SP3 and CLK
await drop(box('参考产品'), [path('1_reference_WUM_final')]);
await box('参考产品').locator('.ant-tag').first().waitFor();
await page.waitForTimeout(1000);
const reference = await kinds('参考产品');
console.log('reference:', reference.length, 'files');
assert.equal(reference.length, 18);

// products with all three kinds, without bias (WHU_ALLOY) and with only bias (COD)
const products = [
  ['2_realtime_products', '2026-09-19_WHU_ABMF'],
  ['2_realtime_products', '2026-10-18_CHC_ALLOY'],
  ['2_realtime_products', '2026-10-18_WHU_ALLOY'],
  ['3_other_final_products'],
];
for (const [i, parts] of products.entries()) {
  if (i > 0) await page.getByRole('button', { name: '添加对比产品' }).click();
  await drop(box(`对比产品 ${i + 1}`), [path(...parts)]);
  await page.waitForTimeout(800);
  console.log(`product ${i + 1}:`, await kinds(`对比产品 ${i + 1}`));
}
assert.equal((await tags('参考产品')).length, 18, 'later drops kept the reference');
assert.deepEqual(await kinds('对比产品 3'), ['CLK', 'SP3'], 'WHU_ALLOY has no biases');
assert.deepEqual(await kinds('对比产品 4'), ['BIA', 'BIA']);
console.log('notice:', (await page.getByTestId('input-note').innerText()).replaceAll('\n', ' | '));

await page.getByRole('button', { name: '开始对比' }).click();
await page.getByText(/已完成对比|没能对比|对比失败/).first().waitFor();
console.log('result line:', await page.getByText(/已完成对比|没能对比|对比失败/).first().innerText());
await page.locator('.ant-segmented-item-label', { hasText: /^偏\s?差$/ }).click();
await page.getByText('各信号的总体 RMS').waitFor();
console.log('both parts have results');
assert.deepEqual(errors, []);
await browser.close();
console.log('compare desktop ok');
