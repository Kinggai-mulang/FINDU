// Native desktop regression for the four matched products, including real partial failures.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const data = process.argv[2];
const expectBds = process.env.FINDU_EXPECT_BDS === '1';
assert.ok(data, 'Pass TEST/PRODUCT_COMPARE/5_matched_2026-10-18');
const output = process.env.FINDU_TEST_OUTPUT ?? 'runtime/matched-products-ui/final';
await fs.mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.FINDYOU_CDP ?? 'http://127.0.0.1:9321');
try {
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const collapse = page.getByRole('button', { name: '折叠日志面板', exact: true });
  if (await collapse.count()) await collapse.click();
  // Run only on the isolated instance: no active engines or pre-existing product inputs.
  assert.equal(
    await page.evaluate(async () => (await window.__TAURI_INTERNALS__.invoke('realtime_overview')).length),
    0,
  );
  await page.getByRole('button', { name: /产品对比/ }).click();
  assert.equal(await page.locator('.product-files .ant-tag').count(), 0);
  const add = async (role, file) => {
    await page.getByLabel(`${role}路径`, { exact: true }).fill(file);
    await page.getByLabel(`${role}添加路径`, { exact: true }).click();
  };
  await add('参考产品', path.join(data, 'reference_WUM'));
  for (let i = 1; i < 4; i++) await page.getByRole('button', { name: '添加对比产品' }).click();
  for (const [i, name] of ['WHU', 'CHC', 'HAS', 'B2B'].entries()) {
    const role = `对比产品 ${i + 1}`;
    await page.getByLabel(`${role}名称`, { exact: true }).fill(name);
    await add(role, path.join(data, 'products', name));
    assert.match(await page.locator(`[data-role="${role}"] .ant-select`).innerText(), /自动判别/);
  }
  await page.waitForFunction(() => document.querySelectorAll('.product-files .ant-tag').length === 15);
  const run = page.getByRole('button', { name: /开始对比/ });
  const resultTag = page.getByText('轨道钟差 4 组 · 偏差 4 组', { exact: true });
  await run.click();
  await resultTag.waitFor();
  assert.equal(await page.getByTestId('orbit-decision').count(), 4);
  assert.equal(await page.getByTestId('orbit-treatments').locator('.ant-tag').count(), 4);
  const screenshot = async (name) => {
    await page.getByRole('tab', { name: '总览', exact: true }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await page.mouse.move(1, 1);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${output}/${name}.png` });
  };
  await screenshot('orbit');
  await page.getByRole('tab', { name: '各卫星', exact: true }).click();
  const systems = page.locator('[aria-label="系统筛选"]');
  await systems.getByText('北斗', { exact: true }).click();
  await page.locator('[aria-label="对比产品"]').getByText('B2B', { exact: true }).click();
  if (expectBds) {
    assert.ok(await page.locator('.ant-table-row').count());
    assert.equal(await page.getByText('B2B 在北斗下没有可比卫星', { exact: true }).count(), 0);
  } else await page.getByText('B2B 在北斗下没有可比卫星', { exact: true }).waitFor();
  assert.ok(await systems.getByText('北斗', { exact: true }).isVisible());
  await systems.getByText('GPS', { exact: true }).click();
  assert.ok(await page.locator('.ant-table-row').count());
  for (const tab of ['时间序列', '分时统计', '覆盖情况']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await page.waitForTimeout(150);
    await screenshot(`orbit-${tab}`);
  }
  await page.locator('[aria-label="对比内容"]').getByText('偏差', { exact: true }).click();
  await page.getByText('各信号的总体 RMS').waitFor();
  assert.equal(await page.getByTestId('bias-tile').count(), 4);
  await page
    .getByTestId('bias-tile')
    .filter({ hasText: 'HAS' })
    .getByText(/无可比/)
    .waitFor();
  await screenshot('bias');
  for (const tab of ['各卫星', '覆盖情况']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await screenshot(`bias-${tab}`);
  }
  await page.getByLabel('对比产品 1名称', { exact: true }).fill('WHU edited');
  assert.equal(await resultTag.count(), 0);
  assert.ok(await page.getByRole('button', { name: '导出 CSV' }).isDisabled());
  await page.getByLabel('对比产品 1名称', { exact: true }).fill('WHU');
  const invalid = path.resolve(output, 'invalid.bia');
  await fs.writeFile(invalid, 'Invalid test bias, no OSB records\n');
  const replaceBias = async (index, file) => {
    await page
      .locator(`[data-role="对比产品 ${index}"] .product-files .ant-tag`)
      .filter({ hasText: 'BIA' })
      .locator('.anticon-close')
      .click();
    await add(`对比产品 ${index}`, file);
    await page.locator(`[data-role="对比产品 ${index}"] .product-files .ant-tag`).filter({ hasText: 'BIA' }).waitFor();
  };
  await replaceBias(1, invalid);
  await run.click();
  await page.getByText('轨道钟差 4 组 · 偏差 3 组', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-role="对比产品 1"] [data-testid="sign-note"]').count(), 0);
  assert.match(await page.locator('[data-role="对比产品 2"] [data-testid="sign-note"]').innerText(), /取反/);
  for (let i = 2; i <= 4; i++) await replaceBias(i, invalid);
  await run.click();
  await page.getByRole('columnheader', { name: '参考匹配率' }).waitFor();
  assert.equal(await page.locator('[aria-label="对比内容"]').count(), 0);
  for (const [i, name] of ['WHU', 'CHC', 'HAS', 'B2B'].entries())
    await replaceBias(i + 1, path.join(data, 'products', name, `2026-10-18_${name}.bia`));
  await run.click();
  await resultTag.waitFor();
  const widths = [];
  for (const width of [1500, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    widths.push(await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })));
    assert.equal(widths.at(-1).scrollWidth, width);
    await screenshot(`orbit-${width}`);
  }
  const native = await page.evaluate(async () => {
    const inputs = JSON.parse(window.localStorage.getItem('findyou.compareInputs'));
    const orbit = (s) => ({
      name: s.name,
      sp3: s.sp3,
      clk: s.clk,
      apc: !!s.apc,
      orbitMode: s.orbitMode ?? 'auto',
      orbitSource: s.orbitSource,
    });
    const bias = (s) => ({ name: s.name, files: s.bia, clocks: s.clk, orbits: s.sp3, sign: s.sign ?? 'auto' });
    const [orbits, biases] = await Promise.all([
      window.__TAURI_INTERNALS__.invoke('compare_products', {
        request: { reference: orbit(inputs.reference), tests: inputs.tests.map(orbit), exclude: [] },
      }),
      window.__TAURI_INTERNALS__.invoke('compare_biases', {
        request: { reference: bias(inputs.reference), tests: inputs.tests.map(bias), exclude: [] },
      }),
    ]);
    return { inputs, orbits, biases };
  });
  await fs.writeFile(`${output}/native-results.json`, JSON.stringify(native));
  assert.equal(native.orbits.results.length, 4);
  assert.equal(native.biases.results.length, 4);
  assert.deepEqual(native.orbits.failures, []);
  assert.deepEqual(native.biases.failures, []);
  assert.ok(native.orbits.results.every((r) => r.orbitDecision?.mode === 'auto'));
  const automatic = native.orbits.results.map((r) => ({
    name: r.name,
    applied: r.apc,
    reason: r.orbitDecision.reason,
  }));
  console.log('Automatic decisions:', automatic);
  const chooseMode = async (label) => {
    await page.getByLabel('对比产品 3轨道参考点', { exact: true }).click();
    await page
      .locator('.ant-select-dropdown:visible .ant-select-item-option-content')
      .getByText(label, { exact: true })
      .click();
    assert.equal(await resultTag.count(), 0);
    assert.equal(await page.getByTestId('orbit-decision').count(), 0);
    assert.ok(await page.getByRole('button', { name: '导出 CSV' }).isDisabled());
    await run.click();
    await resultTag.waitFor();
  };
  await chooseMode('轨道：保持原值');
  assert.match(
    await page.locator('[data-role="对比产品 3"] [data-testid="orbit-decision"]').innerText(),
    /手动 · 保持原值/,
  );
  await chooseMode('轨道：去径向常量');
  assert.match(
    await page.locator('[data-role="对比产品 3"] [data-testid="orbit-decision"]').innerText(),
    /手动 · 已去径向常量/,
  );
  await chooseMode('轨道：自动判别');
  await page.locator('[data-role="对比产品 3"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/automatic-settings.png` });
  // Renaming does not turn a generic SP3 into a trusted APC source, even with a large constant offset.
  const unknownPath = path.resolve(output, 'unknown.sp3');
  await fs.copyFile(native.inputs.tests[2].sp3[0], unknownPath);
  const check = await page.evaluate(
    async ({ inputs, unknownPath }) => {
      const test = inputs.tests[2];
      const request = {
        reference: inputs.reference,
        tests: [
          { ...test, sp3: [unknownPath], orbitSource: undefined, orbitMode: 'auto', name: 'unknown' },
          { ...test, orbitMode: 'keep', name: 'manual keep' },
          { ...test, orbitMode: 'remove', name: 'manual remove' },
        ],
        exclude: [],
      };
      return window.__TAURI_INTERNALS__.invoke('compare_products', { request });
    },
    { inputs: native.inputs, unknownPath },
  );
  assert.deepEqual(check.failures, []);
  assert.deepEqual(
    check.results.map((r) => r.apc),
    [false, false, true],
  );
  assert.match(check.results[0].orbitDecision.reason, /待确认/);
  assert.deepEqual(check.results[0].satellites, check.results[1].satellites);
  await fs.writeFile(`${output}/manual-and-unknown.json`, JSON.stringify(check));
  assert.deepEqual(errors, []);
  await fs.writeFile(
    `${output}/validation.json`,
    JSON.stringify(
      {
        passed: true,
        widths,
        errors,
        orbitGroups: 4,
        biasGroups: 4,
        automatic,
        manualOverrides: true,
        unknownKept: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'Native four-product comparisons, all tabs, filter switching, stale results, partial/all bias failures and 1280/1500 layout passed',
  );
} finally {
  await browser.close();
}
