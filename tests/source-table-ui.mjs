// Browser check of the NTRIP source table dialog with a mocked IPC. Needs `pnpm dev --host 127.0.0.1` and Edge.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

await fs.mkdir('runtime/source-table-ui', { recursive: true });
await fs.writeFile(
  'runtime/source-table-ui/index.html',
  '<html><head><meta charset="UTF-8"></head><body style="background:#10141c;color:#dde5f2;margin:24px"><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
);
await fs.writeFile(
  'runtime/source-table-ui/main.tsx',
  `import React from 'react';import {createRoot} from 'react-dom/client';import {ConfigProvider,App,Form,theme} from 'antd';import {MountpointInput} from '/src/components/SourceTable';import '/src/native-styles.css';
function Demo(){const [form]=Form.useForm();const [last,setLast]=React.useState('');return <Form form={form} layout="vertical" initialValues={{ROVE_NTRIP_CasterHost:'caster.example',ROVE_NTRIP_Port:'2101',ROVE_NTRIP_UserID:'user',ROVE_NTRIP_Password:'secret',ROVE_NTRIP_Mountpoint:''}} onValuesChange={(c)=>setLast(JSON.stringify(c))}><Form.Item name="ROVE_NTRIP_Mountpoint" label="挂载点"><MountpointInput prefix="ROVE"/></Form.Item><pre id="last">{last}</pre></Form>;}
createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{algorithm:theme.darkAlgorithm}}><App><Demo/></App></ConfigProvider>);`,
);
const table = [
  ['FAR1', 'Far', 'RTCM 3.2', 'GPS+GLO', 'DEU', 50.1, 8.6, false, ['OBS'], 'N'],
  ['NEAR1', 'Near', 'RTCM 3.2', 'GPS+BDS+GAL', 'CHN', 30.6, 114.4, true, ['OBS', 'EPH'], 'B'],
  ['SSR1', 'Ssr', 'RTCM 3.3', 'GPS', 'CHN', 31.0, 114.0, false, ['SSR'], 'B'],
].map(([mountpoint, identifier, format, systems, country, latitude, longitude, nmea, kinds, authentication]) => ({
  mountpoint,
  identifier,
  format,
  details: '1005(10),1077(1)',
  systems,
  network: 'NET',
  country,
  latitude,
  longitude,
  nmea,
  authentication,
  bitrate: 5000,
  messages: [1005, 1077],
  kinds,
}));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.addInitScript((rows) => {
  window.calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.calls.push({ command, ...args });
      if (command === 'ntrip_sourcetable') return rows;
      if (command === 'ntrip_probe')
        return {
          windowSeconds: 8,
          bytes: 20480,
          messages: [
            { id: 1005, count: 1 },
            { id: 1077, count: 8 },
          ],
        };
      throw new Error('unexpected ' + command);
    },
  };
}, table);
await page.goto('http://127.0.0.1:1420/runtime/source-table-ui/index.html');
await page.getByRole('button', { name: '浏览源表' }).click();
await page.getByText('NEAR1').waitFor();
const first = await page.evaluate(() => window.calls[0]);
assert.deepEqual(
  { command: first.command, host: first.host, port: first.port, user: first.user, password: first.password },
  { command: 'ntrip_sourcetable', host: 'caster.example', port: 2101, user: 'user', password: 'secret' },
);
assert.equal(await page.locator('.ant-table-row').count(), 3);
// Without a position the list is alphabetical.
assert.equal(await page.locator('.ant-table-row').first().getAttribute('data-row-key'), 'FAR1');
await page.getByLabel('大致位置').fill('30.5, 114.3');
await page.waitForFunction(() => document.querySelector('.ant-table-row')?.getAttribute('data-row-key') === 'NEAR1');
await page.getByText('含 SSR 改正').click();
assert.equal(await page.locator('.ant-table-row').count(), 1);
await page.getByText('全部', { exact: true }).click();
await page.getByLabel('搜索挂载点').fill('near');
assert.equal(await page.locator('.ant-table-row').count(), 1);
await page.locator('.ant-table-row').first().click();
await page.getByText(/虚拟站 \/ 网格站/).waitFor();
// Column widths are adjustable by dragging the header edge and the choice is remembered.
const head = page.locator('.ant-table-thead th', { hasText: '导航系统' });
const before = (await head.boundingBox()).width;
const handle = head.locator('.column-resize-handle');
const box = await handle.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 });
await page.mouse.up();
const after = (await head.boundingBox()).width;
assert.ok(after > before + 80, `column should widen: ${before} -> ${after}`);
assert.ok(
  await page.evaluate(
    () => JSON.parse(window.localStorage.getItem('findyou.sourceTableLayout') ?? '{}').widths?.systems > 250,
  ),
);
// Hidden columns can be turned on from the column menu.
assert.equal(await page.locator('.ant-table-thead th', { hasText: '网络' }).count(), 0);
await page.getByRole('button', { name: /列$/ }).click();
await page.getByRole('checkbox', { name: '网络' }).check();
await page.locator('.ant-table-thead th', { hasText: '网络' }).waitFor();
await page.getByText('NTRIP 源表', { exact: true }).click();
await page.getByRole('button', { name: /探测所选挂载点/ }).click();
await page.getByText(/1077×8/).waitFor();
await page.getByRole('button', { name: '使用此挂载点' }).click();
await page.waitForFunction(() => document.querySelector('#last')?.textContent?.includes('NEAR1'));
assert.equal(await page.locator('input').first().inputValue(), 'NEAR1');
await page.screenshot({ path: 'runtime/source-table-ui/result.png' });
assert.deepEqual(errors, []);
await browser.close();
console.log('source table UI ok');
