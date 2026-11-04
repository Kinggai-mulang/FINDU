// Multi-session startup failures must remain visible without stopping later selected rows.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const folder = 'runtime/realtime-start-ui';
await fs.mkdir(folder, { recursive: true });
await fs.writeFile(
  `${folder}/index.html`,
  `<html><meta charset="utf-8"><div id="root"></div><script type="module" src="./main.tsx?run=${Date.now()}"></script></html>`,
);
await fs.writeFile(
  `${folder}/main.tsx`,
  `import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import RealtimeWorkspace from '/src/pages/RealtimeWorkspace';import {antdThemeConfig} from '/src/theme';import {realtimeEditors,manualSource} from '/src/services/realtime-drafts';import '/src/styles.css';import '/src/native-styles.css';import '/src/configuration.css';window.failPreparation=()=>{const editor=[...realtimeEditors.values()].find(e=>e.document?.name==='2.opt');editor.document.sourcePath=manualSource+'two';};createRoot(document.getElementById('root')!).render(<ConfigProvider theme={antdThemeConfig}><App><RealtimeWorkspace onResults={()=>{}}/></App></ConfigProvider>);`,
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.preparationFails = true;
    window.nativeFails = true;
    window.publish = false;
    window.startCalls = [];
    window.sessions = new Map();
    const document = (path) => ({
      sourcePath: path,
      name: path.split('/').at(-1),
      values: {
        GNSS_PMode: '2',
        GNSS_ARMode: '0',
        ROVE_NTRIP_CasterHost: '127.0.0.1',
        ROVE_NTRIP_Port: '2101',
        ROVE_NTRIP_Mountpoint: 'test',
        PRODUCT_NTRIP_CasterHost: '127.0.0.1',
        PRODUCT_NTRIP_Port: '2101',
        PRODUCT_NTRIP_Mountpoint: 'products',
        PRODUCT_NTRIP_Type: 'SSR',
      },
    });
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command, args = {}) => {
        if (command.startsWith('plugin:')) return 1;
        if (command === 'runtime_paths') return { root: 'D:/test', realtime: 'D:/test/realtime' };
        if (command === 'native_snapshot') return { tasks: [], logs: [], concurrency: 2 };
        if (command === 'import_realtime') return document(args.path);
        if (command === 'create_live_document') {
          if (window.preparationFails) throw '请填写 ROVE 地址和挂载点';
          return document('D:/test/2.opt');
        }
        if (command === 'start_realtime') {
          window.startCalls.push(args.request.sourcePath);
          if (window.nativeFails && args.request.sourcePath.endsWith('3.opt')) throw 'ANTEX 文件不存在';
          await new Promise((resolve) => setTimeout(resolve, 100));
          const key = args.sessionId || 'manual';
          window.sessions.set(key, {
            sessionKey: key,
            id: window.crypto.randomUUID(),
            label: args.request.label,
            station: args.request.station,
            sourcePath: args.request.sourcePath,
            state: 'running',
            solutionMode: 'PPP',
            productType: 'SSR',
            configName: 'test',
            epochs: [],
            history: [],
            productHistory: [],
            logs: [],
            bufferedEpochs: 0,
            receivedEpochs: 0,
            analysisConfig: {},
            engineCommit: 'test',
            heartbeat: null,
            error: null,
            metrics: null,
            referenceXyz: null,
          });
          return key;
        }
        if (command === 'realtime_overview') return window.publish ? [...window.sessions.values()].reverse() : [];
        if (command === 'realtime_deltas')
          return args.requests.flatMap(({ sessionId }) => {
            const summary = window.sessions.get(sessionId);
            if (!summary) return [];
            const slice = () => ({ start: 0, from: 0, end: 0, items: [] });
            return [
              { summary, generation: 1, epochs: slice(), history: slice(), productHistory: slice(), logs: slice() },
            ];
          });
        if (command === 'stop_realtime') {
          window.sessions.get(args.sessionId).state = 'stopped';
          return null;
        }
        if (command === 'stop_all_realtime') {
          for (const s of window.sessions.values()) s.state = 'stopped';
          return null;
        }
        throw new Error('Unexpected command ' + command);
      },
    };
  });
  await page.goto(`http://127.0.0.1:1420/${folder}/index.html`);
  await page.getByLabel('多路实时 OPT 路径').fill([1, 2, 3, 4, 5].map((n) => `D:/test/${n}.opt`).join('|'));
  await page.getByRole('button', { name: '载入方案', exact: true }).click();
  const rows = page.locator('.ant-table-row');
  await page.waitForFunction(() => document.querySelectorAll('.ant-table-row').length === 5);
  await page.evaluate(() => window.failPreparation());
  await page.getByLabel('启动所选方案', { exact: true }).click();
  await page.getByText('3 路已提交，2 路未启动；原因见对应方案行', { exact: true }).waitFor();
  assert.equal(await rows.count(), 5, 'accepted requests retain rows while overview is delayed');
  assert.equal(
    (await page.evaluate(() => window.startCalls)).length,
    4,
    'preflight failure does not abort later requests',
  );
  assert.match(await rows.nth(1).innerText(), /启动失败[\s\S]*请填写 ROVE/);
  assert.match(await rows.nth(2).innerText(), /启动失败[\s\S]*ANTEX 文件不存在/);
  await page.evaluate(() => {
    window.publish = true;
  });
  await page.waitForFunction(
    () => [...document.querySelectorAll('.ant-table-row')].filter((n) => n.textContent.includes('运行中')).length === 3,
  );
  assert.deepEqual(
    await rows.locator('.live-row-name strong').allTextContents(),
    ['01_1', '02_2', '03_3', '04_4', '05_5'],
    'native UUID order does not reorder configured rows',
  );
  await page.evaluate(() => {
    window.preparationFails = false;
  });
  await rows.nth(1).getByRole('button', { name: '重试启动', exact: true }).click();
  await page.waitForFunction(() => window.sessions.size === 4);
  await page.evaluate(() => {
    window.nativeFails = false;
  });
  await rows.nth(2).getByRole('button', { name: '详情 / 配置', exact: true }).click();
  await page.getByLabel('仅启动当前方案', { exact: true }).click();
  await page.waitForFunction(() => window.sessions.size === 5);
  assert.equal(await rows.count(), 5);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ant-table-row')].every((n) => n.textContent.includes('运行中')),
  );
  await rows.nth(2).getByRole('button', { name: '停止', exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.ant-table-row')].some((n) => n.textContent.includes('已停止')),
  );
  assert.equal(await page.evaluate(() => [...window.sessions.values()].filter((s) => s.state === 'running').length), 4);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${folder}/passed.png`, fullPage: true });
  console.log(
    'Five rows: isolated preflight/native failures, pending visibility, stable order, row/detail retry, independent stop passed',
  );
} finally {
  await browser.close();
}
