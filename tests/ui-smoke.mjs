import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { defaultConfigFixture } from './ui-values.mjs';

const output='deliverables/screenshots';
await fs.mkdir(output,{recursive:true});
const desktop=process.env.FINDYOU_CDP;
const browser=desktop?await chromium.connectOverCDP(desktop):await chromium.launch({channel:'msedge',headless:true});
const context=desktop?browser.contexts()[0]:await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true});
const page=desktop?context.pages()[0]:await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
if(!desktop)await page.goto('http://127.0.0.1:1420');
await page.waitForSelector('.nav-item');
await page.getByRole('button',{name:'实时监控 Monitor'}).click();
if(desktop)await page.getByRole('button',{name:'模拟监控',exact:true}).click();
if(await page.getByRole('button',{name:/停止模拟/}).count())await page.getByRole('button',{name:/停止模拟/}).click();
await page.getByRole('button',{name:/启动模拟/}).click();
await page.waitForFunction(()=>document.querySelector('.metric-value')?.textContent.includes('SPP'));
await page.waitForTimeout(4000);
assert.ok(await page.locator('canvas').count()>0,'实时位置图应已渲染');
await page.screenshot({path:`${output}/${desktop?'desktop-':''}01-monitor.png`});
await page.getByRole('button',{name:'后处理 Processing'}).click();
if(desktop)await page.getByRole('button',{name:'模拟演示',exact:true}).click();
await page.getByRole('button',{name:/创建模拟任务/}).click();
await page.waitForFunction(()=>document.querySelector('.ant-table-tbody')?.textContent.includes('运行中'));
await page.screenshot({path:`${output}/${desktop?'desktop-':''}02-post.png`});
await page.getByRole('button',{name:'数据与下载 Data & Products'}).click();
await page.getByRole('heading',{name:'数据与下载',exact:true}).waitFor();
await page.getByLabel('产品等级',{exact:true}).waitFor();
await page.screenshot({path:`${output}/${desktop?'desktop-':''}03-products.png`});
await page.getByRole('button',{name:'后处理 Processing'}).click();
await page.getByRole('button',{name:'查看结果',exact:true}).first().waitFor({timeout:20000});
await page.getByRole('button',{name:'查看结果',exact:true}).first().click();
await page.getByRole('heading',{name:'分析对比',exact:true}).waitFor();
assert.ok((await page.locator('.ant-table-tbody').textContent()).includes('1800'));
await page.screenshot({path:`${output}/${desktop?'desktop-':''}04-analysis.png`});
if(!desktop){
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:/导出指标 CSV/}).click();
  const d=await downloadPromise;assert.ok((await fs.readFile(await d.path(),'utf8')).includes('E_RMS_m'));
  await page.setViewportSize({width:1280,height:800});
  for(const name of ['实时监控 Monitor','后处理 Processing','数据与下载 Data & Products','分析对比 Analysis']){
    await page.getByRole('button',{name}).click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${name} body overflow`);
  }
  await page.screenshot({path:`${output}/05-minimum-window.png`});
  await page.getByRole('button',{name:'后处理 Processing'}).click();
  await page.getByRole('button',{name:/创建模拟任务/}).click();
  await page.getByRole('button',{name:'取消',exact:true}).first().click();
  await page.locator('.ant-table-tbody').getByText('已取消',{exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'模拟产品覆盖不足，验证失败流程'}).check();
  await page.getByRole('button',{name:/创建模拟任务/}).click();
  await page.locator('.ant-table-tbody').getByText('失败',{exact:true}).waitFor({timeout:12000});
  await page.reload();await page.getByRole('button',{name:'数据与下载 Data & Products'}).click();
  await page.getByRole('heading',{name:'数据与下载',exact:true}).waitFor();
}
await page.getByRole('button',{name:'实时监控 Monitor'}).click();
if(desktop)await page.getByRole('button',{name:'模拟监控',exact:true}).click();
if(await page.getByRole('button',{name:/停止模拟/}).count())await page.getByRole('button',{name:/停止模拟/}).click();
assert.deepEqual(errors,[],`Browser errors: ${errors.join(', ')}`);
console.log(`${desktop?'Desktop WebView2':'Browser'} smoke passed: navigation, live charts, task result, data/products navigation${desktop?'':', import/export, cancel/failure, 1280×800'}.`);
if(desktop)await browser.close();else await browser.close();


