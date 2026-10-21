import { useState } from 'react';
import { App, Button, Checkbox, Form, Input, Select, Space, Table, Tag, Progress, Alert } from 'antd';
import { FolderOpenOutlined, PlayCircleOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { EngineService, SolverConfig, Task, WorkbenchSnapshot } from '../../contracts';
import { sampleInputs } from '../../mock/data';
import { statusColors, statusText } from '../domain';
import { isDesktop, pickPath } from '../services/files';
import { PageHeading, Panel } from '../components/common';

export default function PostProcess({snapshot,service,templates,onResult}:{snapshot:WorkbenchSnapshot;service:EngineService;templates:SolverConfig[];onResult:(id:string)=>void}) {
  const [input,setInput]=useState(sampleInputs[0].value);const [output,setOutput]=useState('示例工作区 / Results');const [template,setTemplate]=useState(0);const [fail,setFail]=useState(false);
  const {message}=App.useApp();
  const browse=async(directory:boolean)=>{try {const path=await pickPath(directory);if(path)directory?setOutput(path):setInput(path);}catch(e){message.error(String(e));}};
  const create=()=>{try{service.createTask({input,outputDir:output,config:templates[template]||templates[0],simulateFailure:fail});message.success('已创建模拟任务，可在队列查看进度');}catch(e){message.error(String(e));}};
  return <div className="page"><PageHeading eyebrow="PROCESSING WORKSPACE" title="后处理" description="从输入观测到结果分析，组织一次完整的处理流程。" actions={<Tag color="blue">模拟引擎 / 串行队列</Tag>}/>
    <div className="post-layout"><Panel title="新建处理任务" extra={<span className="step-number">01 / CONFIGURE</span>}>
      <Form layout="vertical" className="task-form">
        <Form.Item label="观测输入"><Space.Compact block><Select aria-label="示例观测输入" value={input} onChange={setInput} options={sampleInputs.some(s=>s.value===input)?sampleInputs:[...sampleInputs,{value:input,label:input}]} style={{flex:1,minWidth:0}}/>{isDesktop()&&<Button aria-label="浏览观测文件" icon={<FolderOpenOutlined/>} onClick={()=>browse(false)}/>}</Space.Compact></Form.Item>
        <Form.Item label="解算配置模板"><Select aria-label="解算配置模板" value={template<templates.length?template:0} onChange={setTemplate} options={templates.map((c,i)=>({value:i,label:c.name}))}/></Form.Item>
        <Form.Item label="输出目录" extra="首轮仅记录目标目录，不写出真实解算文件。"><Space.Compact block><Input aria-label="输出目录" value={output} onChange={e=>setOutput(e.target.value)}/>{isDesktop()&&<Button aria-label="浏览输出目录" icon={<FolderOpenOutlined/>} onClick={()=>browse(true)}/>}</Space.Compact></Form.Item>
        <div className="config-summary"><div><span>模式</span><strong>{templates[template]?.mode||templates[0].mode}</strong></div><div><span>采样</span><strong>{templates[template]?.intervalSec||templates[0].intervalSec} s</strong></div><div><span>数据来源</span><strong>本地模拟</strong></div></div>
        <Checkbox checked={fail} onChange={e=>setFail(e.target.checked)}>模拟产品覆盖不足，验证失败流程</Checkbox>
        <Button type="primary" block size="large" icon={<PlayCircleOutlined/>} onClick={create} disabled={!input.trim()||!output.trim()} style={{marginTop:24}}>创建模拟任务</Button>
      </Form>
    </Panel><div className="post-right"><Panel title="处理队列" extra={<span className="subtle">{snapshot.tasks.length} 个任务 · 最多 10 个待处理</span>}><Table<Task> rowKey="id" size="small" pagination={{pageSize:5,hideOnSinglePage:true}} dataSource={snapshot.tasks} locale={{emptyText:'暂无任务 · 从左侧创建第一个模拟任务'}} scroll={{x:560}} columns={[
      {title:'任务 / 输入',dataIndex:'name',render:(name:string,t)=><div className="task-cell"><strong>{name}</strong><small>{t.request.config.mode} · {t.request.config.name}</small></div>},
      {title:'状态',width:100,render:(_,t)=><Tag color={statusColors[t.status]}>{statusText[t.status]}</Tag>},
      {title:'进度',width:120,render:(_,t)=><Progress percent={t.progress} size="small" status={t.status==='failed'?'exception':t.status==='succeeded'?'success':'normal'}/>},
      {title:'操作',width:90,render:(_,t)=>t.status==='succeeded'?(snapshot.results.some(r=>r.id===t.resultId)?<Button size="small" type="link" onClick={()=>onResult(t.resultId!)}>查看结果</Button>:<span className="subtle">缓存已清理</span>):['queued','running'].includes(t.status)?<Button size="small" type="link" danger onClick={()=>service.cancelTask(t.id)}>取消</Button>:<span className="subtle">—</span>}
    ]} expandable={{expandedRowRender:t=><div className="task-detail"><p>目标目录：{t.request.outputDir}</p><p>创建时间：{t.createdAt} · 任务 ID：{t.id}</p>{t.error&&<Alert type="error" showIcon title={t.error}/>}</div>}}/></Panel>
      <Panel title="工作流" extra={<span className="step-number">02 / EXECUTE</span>}><div className="workflow"><div><b>01</b><strong>准备观测</strong><small>示例或本地文件路径</small></div><ArrowRightOutlined/><div><b>02</b><strong>模拟解算</strong><small>进度 / 日志 / 取消</small></div><ArrowRightOutlined/><div><b>03</b><strong>分析结果</strong><small>曲线与指标统一计算</small></div></div><Alert type="info" showIcon title="浏览器使用示例输入；桌面支持选择本地路径。两者均运行模拟引擎，不读取观测内容。"/></Panel>
    </div></div>
  </div>;
}
