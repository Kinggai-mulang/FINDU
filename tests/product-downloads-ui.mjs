import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

await fs.mkdir('runtime/downloads-ui', { recursive: true });
await fs.writeFile(
  'runtime/downloads-ui/index.html',
  `<html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="./main.tsx?run=${Date.now()}"></script></body></html>`,
);
await fs.writeFile(
  'runtime/downloads-ui/main.tsx',
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfigProvider,App} from 'antd';import DataDownloads from '/src/pages/DataDownloads';import {antdThemeConfig} from '/src/theme';import '/src/styles.css';import '/src/native-styles.css';createRoot(document.getElementById('root')!).render(<ConfigProvider theme={antdThemeConfig}><App><DataDownloads onPrepared={()=>{}}/></App></ConfigProvider>);`,
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.calls = [];
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args) => {
        window.calls.push({ command, args });
        if (command === 'runtime_paths') return { root: 'D:/test/runtime' };
        if (command === 'validate_input_path') return args.path;
        if (command === 'plugin:dialog|open') return 'D:/local/igs20.atx';
        if (command === 'product_jobs')
          return ['running', 'unavailable', 'ok'].map((status, index) => ({
            job: {
              id: String(index),
              name: ['DCB 更新中', 'DCB 缺失', 'DCB 缓存回退'][index],
              status: 'ready',
              request: { centers: ['WHU'], grade: 'final', mode: 'ar', motion: 'static' },
            },
            manifest: { ready: true, results: [{ id: 'one', status: 'ready', opt: 'D:/test/one.opt' }] },
            dcb: {
              status,
              ...(status === 'ok'
                ? {
                    origin: 'cache',
                    updateStatus: 'fallback',
                    checkedAt: '2026-11-04T09:00:00Z',
                    metadata: {
                      start_gpst: '2026-10-31T00:00:00',
                      end_gpst: '2026-11-01T00:00:00',
                      hold_expiry_gpst: '2026-11-16T00:00:00',
                    },
                  }
                : {}),
            },
          }));
        if (command.startsWith('plugin:')) return 1;
        return null;
      },
    };
  });
  await page.goto('http://127.0.0.1:1420/runtime/downloads-ui/index.html');
  await page.getByText(/产品与 OPT：D:\/test\/runtime\/downloads/).waitFor();
  await page.getByText(/产品缓存：D:\/test\/runtime\/cache\/products/).waitFor();
  await page.getByText(/目录随程序所在位置自动确定并创建/).waitFor();
  await page.getByText('主配置可用 · DCB 仍在准备', { exact: true }).waitFor();
  await page.getByText('配置可用 · 存在缺项', { exact: true }).waitFor();
  await page.getByText('配置可用 · 产品版本未联网确认', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '重新检查主产品' }).first().isDisabled(), true);
  await page.getByRole('button', { name: '清除已结束' }).click();
  const dismissed = await page.evaluate(() => window.calls.find((call) => call.command === 'dismiss_products'));
  assert.equal(dismissed.args.ids, null, 'backend clears completed records beyond the visible page too');
  assert.equal(await page.locator('.ant-progress').count(), 0, 'candidate counts must not imply download percent');
  assert.equal(await page.getByText(/文件拖放未就绪/).count(), 0);
  assert.equal(await page.locator('.downloads-layout').evaluate((node) => getComputedStyle(node).display), 'grid');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByText('天线与 DCB', { exact: true }).waitFor();
  assert.ok(await page.getByText('拖入DCB 码偏差文件，或点击浏览', { exact: true }).isVisible());
  await page.getByRole('button', { name: '选择 GNSS_ATXFile', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('[aria-label="GNSS_ATXFile"]').value === 'D:/local/igs20.atx',
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'GNSS_ATXFile', exact: true }).inputValue(),
    'D:/local/igs20.atx',
  );
  const updateAntenna = page.getByRole('checkbox', {
    name: '自动选择天线时，允许下载并检查匹配 ANTEX 的版本',
    exact: true,
  });
  assert.ok(await updateAntenna.isDisabled());
  await page.getByRole('textbox', { name: 'GNSS_DCBFile', exact: true }).fill('D:/local/CAS_DSB.BSX');
  await page.getByRole('textbox', { name: '产品下载观测路径', exact: true }).fill('D:/local/obs.rnx');
  await page.getByRole('button', { name: /准备产品并生成 OPT/ }).click();
  const prepared = await page.evaluate(() => window.calls.find((c) => c.command === 'start_product').args.request);
  assert.equal(prepared.antennaPath, 'D:/local/igs20.atx');
  assert.equal(prepared.dcbPath, 'D:/local/CAS_DSB.BSX');
  await page.getByRole('button', { name: '清空 GNSS_ATXFile', exact: true }).click();
  await page.getByRole('button', { name: '清空 GNSS_DCBFile', exact: true }).click();
  assert.ok(await updateAntenna.isEnabled());
  assert.equal(await page.getByText('自动检查更新', { exact: true }).count(), 2);
  await page.screenshot({ path: 'runtime/downloads-ui/statuses.png', fullPage: true });
  const preview = await browser.newPage();
  await preview.goto('http://127.0.0.1:1420/runtime/downloads-ui/index.html');
  await preview.getByText('桌面版启动后显示实际存储位置。', { exact: true }).waitFor();
  assert.equal(await preview.getByText(/产品与 OPT：/).count(), 0);
  await preview.close();
  assert.deepEqual(errors, []);
  console.log('Product downloads UI: three readiness states, safe dismiss, no script errors or horizontal overflow');
} finally {
  await browser.close();
}
