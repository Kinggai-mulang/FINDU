import { useState } from 'react';
import { App, Alert, Button, Checkbox, Form, Input, InputNumber, Select, Space, Tag } from 'antd';
import { DownloadOutlined, UploadOutlined, SaveOutlined, FolderOpenOutlined } from '@ant-design/icons';
import type { SolverConfig } from '../../contracts';
import { defaultConfig, parseConfig, validateConfig } from '../domain';
import { exportText, isDesktop, pickPath, readJsonFile } from '../services/files';
import { PageHeading, Panel } from '../components/common';

export default function Configuration({templates,onSave}:{templates:SolverConfig[];onSave:(c:SolverConfig)=>void}) {
  const [form]=Form.useForm<SolverConfig>();const [errors,setErrors]=useState<string[]>([]);const [busy,setBusy]=useState<'import'|'export'|null>(null);const {message}=App.useApp();
  const current=()=>({...form.getFieldsValue(),schemaVersion:1 as const});
  const validate=()=>{const c=current();const issues=validateConfig(c);setErrors(issues);if(issues.length)throw new Error(issues.join('；'));return parseConfig(JSON.stringify(c));};
  const save=()=>{try{const c=validate();onSave(c);message.success('模板已保存到本机');}catch(e){message.error(String(e));}};
  const importConfig=async()=>{setBusy('import');try{const raw=await readJsonFile();if(raw===null)return;const c=parseConfig(raw);form.setFieldsValue(c);setErrors([]);message.success('配置已载入，检查后可保存为模板');}catch(e){message.error('导入失败：'+String(e));}finally{setBusy(null);}};
  const exportConfig=async()=>{setBusy('export');try{const c=validate();if(await exportText('findyou-config.json',JSON.stringify(c,null,2)))message.success('配置已导出');}catch(e){message.error(String(e));}finally{setBusy(null);}};
  return <div className="page"><PageHeading eyebrow="CONFIGURATION" title="配置中心" description="管理可复用的解算模板，保持每次处理的参数可追溯。" actions={<Space><Button loading={busy==='import'} disabled={busy==='export'} icon={<UploadOutlined/>} onClick={importConfig}>导入 JSON</Button><Button loading={busy==='export'} disabled={busy==='import'} icon={<DownloadOutlined/>} onClick={exportConfig}>导出 JSON</Button><Button disabled={!!busy} type="primary" icon={<SaveOutlined/>} onClick={save}>保存模板</Button></Space>}/>
    <Alert type="info" showIcon title="此页管理演示用 JSON 模板；真实任务请在后处理编辑 OPT，实时参数请在「实时监控 → 数据源与配置」中设置。" style={{marginBottom:16}}/>
    <div className="configuration-layout"><div><Panel title="解算参数" extra={<Tag bordered={false}>FINDU 配置 v1</Tag>}>
      <Form form={form} layout="vertical" initialValues={templates[0]||defaultConfig} className="config-form">
        <div className="form-grid"><Form.Item name="name" label="模板名称"><Input maxLength={80} placeholder="为策略命名"/></Form.Item><Form.Item label="载入已有模板"><Select aria-label="载入已有模板" placeholder="选择本地模板" options={templates.map((c,i)=>({value:i,label:c.name}))} onChange={i=>{form.setFieldsValue(templates[i]);setErrors([]);}}/></Form.Item></div>
        <div className="form-divider"><span>01</span> 基本解算设置</div>
        <div className="form-grid"><Form.Item name="mode" label="解算模式"><Select options={['SPP','RTK','PPP'].map(value=>({value,label:{SPP:'SPP · 单点定位',RTK:'RTK · 差分定位',PPP:'PPP · 精密单点定位'}[value]}))}/></Form.Item><Form.Item name="systems" label="卫星系统"><Checkbox.Group options={['GPS','BDS','GAL','GLO']}/></Form.Item><Form.Item name="elevationDeg" label="截止高度角 / °" extra="有效范围 0–60°"><InputNumber style={{width:'100%'}} min={0} max={60}/></Form.Item><Form.Item name="intervalSec" label="采样间隔 / s" extra="有效范围 0.1–3600 秒"><InputNumber style={{width:'100%'}} min={0.1} max={3600} step={0.1}/></Form.Item></div>
        <div className="form-divider"><span>02</span> 产品与资源</div>
        <Form.Item label="产品目录" extra="可留空；模拟模式下不读取产品文件。"><Space.Compact block><Form.Item noStyle name="productPath"><Input placeholder="精密星历、钟差等产品目录"/></Form.Item>{isDesktop()&&<Button aria-label="浏览产品目录" icon={<FolderOpenOutlined/>} onClick={async()=>{try{const p=await pickPath(true);if(p)form.setFieldValue('productPath',p);}catch(e){message.error(String(e));}}}/>}</Space.Compact></Form.Item>
      </Form>
      {errors.length>0&&<Alert type="error" showIcon title="请修正配置" description={errors.join('；')} style={{margin:'0 24px 24px'}}/>}
    </Panel></div><div className="config-aside"><Panel title="模板说明"><div className="prose"><div className="template-glyph">{`{ }`}</div><h3>一次定义，多次复用</h3><p>保存后，后处理页面可直接选择此模板。已创建任务保留创建时的参数快照。</p><dl><dt>持久化</dt><dd>当前设备的本地存储</dd><dt>格式</dt><dd>FINDU JSON · schemaVersion 1</dd><dt>算法映射</dt><dd>演示模板；真实任务直接使用 OPT</dd></dl></div></Panel><Alert type="info" showIcon title="配置边界" description="此 JSON 是 FINDU 应用配置，不等同于 IPSPOS .opt 文件。模拟曲线用于交互验证，不能评估参数的真实解算效果。"/></div></div>
  </div>;
}

