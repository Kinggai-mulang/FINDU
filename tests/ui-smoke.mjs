// UI smoke test: every page renders without script errors and fits a 1280×800 window.
// Browser preview: start `pnpm dev`, then `pnpm test:ui`. Desktop: set FINDYOU_CDP to a running copy's debug address.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const output = 'deliverables/screenshots';
await fs.mkdir(output, { recursive: true });
const desktop = process.env.FINDYOU_CDP;
const browser = desktop
  ? await chromium.connectOverCDP(desktop)
  : await chromium.launch({ channel: 'msedge', headless: true });
const context = desktop ? browser.contexts()[0] : await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = desktop ? context.pages()[0] : await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
if (!desktop) await page.goto('http://127.0.0.1:1420');
await page.waitForSelector('.nav-item');
const prefix = desktop ? 'desktop-' : '';
const pages = [
  ['实时监控 Monitor', '实时工作区', '01-monitor'],
  ['后处理 Processing', null, '02-post'],
  ['数据与下载 Data & Products', '数据与下载', '03-products'],
  ['分析对比 Analysis', '分析对比', '04-analysis'],
];
for (const [nav, heading, shot] of pages) {
  await page.getByRole('button', { name: nav }).click();
  if (heading) await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${output}/${prefix}${shot}.png` });
}
if (!desktop) {
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const [nav] of pages) {
    await page.getByRole('button', { name: nav }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `${nav} body overflow`,
    );
  }
  await page.screenshot({ path: `${output}/05-minimum-window.png` });
}
assert.deepEqual(errors, [], `Browser errors: ${errors.join(', ')}`);
console.log(
  `${desktop ? 'Desktop WebView2' : 'Browser'} smoke passed: all pages render${desktop ? '' : ', 1280×800'}.`,
);
await browser.close();
