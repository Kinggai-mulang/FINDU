import { useEffect, useState, useSyncExternalStore } from 'react';
import { App as AntApp, Button, ConfigProvider, Select, Space, Splitter, Tabs, Tag, Tooltip, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RadarChartOutlined, SettingOutlined, LineChartOutlined, ApartmentOutlined, DashboardOutlined, DownOutlined, UpOutlined, CheckCircleOutlined, CodeOutlined } from '@ant-design/icons';
import type { Task, OptDocument, EngineInfo } from '../contracts';
import { workbenchEngine as engine } from './services/native-engine';
import { loadTemplates, readStored, writeStored } from './services/storage';
import { isDesktop } from './services/files';
import { statusColors, statusText, utcLabel } from './domain';
import Monitor from './pages/Monitor';
import RealtimeWorkspace from './pages/RealtimeWorkspace';
import PostProcess from './pages/PostProcess';
import DataDownloads from './pages/DataDownloads';
import Analysis from './pages/Analysis';
import NativePostProcess from './pages/NativePostProcess';
import mark from '../resources/mark.png';
import './styles.css';
import './native-styles.css';
import './configuration.css';

type Page='monitor'|'post'|'config'|'analysis';
const navigation=[{id:'monitor' as const,label:'实时监控',english:'Monitor',icon:<RadarChartOutlined/>},{id:'post' as const,label:'后处理',english:'Processing',icon:<ApartmentOutlined/>},{id:'config' as const,label:'数据与下载',english:'Data & Products',icon:<SettingOutlined/>},{id:'analysis' as const,label:'分析对比',english:'Analysis',icon:<LineChartOutlined/>}];
function Workbench() {
  const raw=useSyncExternalStore(engine.subscribe,engine.getSnapshot);
  const [engineInfo,setEngineInfo]=useState<EngineInfo>();
  useEffect(()=>{if(isDesktop())void engine.info().then(setEngineInfo).catch(()=>setEngineInfo(undefined));},[]);
  const [showDemo,setShowDemo]=useState(!isDesktop()||readStored('showDemo',false));
  const snapshot=showDemo?raw:{...raw,tasks:raw.tasks.filter(t=>t.source==='ipspos'),results:raw.results.filter(r=>r.source!=='mock'),logs:raw.logs.filter(l=>l.id>=1000000)};
  const storedPage=readStored<string>('page','monitor');
  const [page,setPage]=useState<Page>(navigation.some(n=>n.id===storedPage)?storedPage as Page:'monitor');
  useEffect(()=>{engine.setAnalysisVisible(page==='analysis');},[page]);
  const [templates]=useState(loadTemplates);
  const [nativeDocuments,setNativeDocuments]=useState<OptDocument[]>([]);
  const [monitorMode,setMonitorMode]=useState<'real'|'demo'>(isDesktop()?'real':'demo');
  useEffect(()=>{engine.setRealtimeVisible(page==='monitor'&&monitorMode==='real');},[page,monitorMode]);
  const [postMode,setPostMode]=useState<'real'|'demo'>(isDesktop()?'real':'demo');
  const [selected,setSelected]=useState<string[]>(['sample-a','sample-b']);
  useEffect(()=>{engine.setVisibleAnalysisResults(selected);},[selected]);
  const [collapsed,setCollapsed]=useState(Boolean(readStored('consoleCollapsed',false)));
  const [consoleTab,setConsoleTab]=useState('logs');const [logFilter,setLogFilter]=useState('all');
  const savedConsole=readStored<number>('consoleHeight',170);const initialConsole=Number.isFinite(savedConsole)?Math.min(300,Math.max(110,savedConsole)):170;
  const {message}=AntApp.useApp();
  const persist=(key:string,value:unknown)=>{try{writeStored(key,value);}catch{message.warning('本地存储不可用，本次更改仅在当前会话保留');}};
  const navigate=(p:Page)=>{setPage(p);persist('page',p);};
  const openResult=async(id:string)=>{const result=snapshot.results.find(r=>r.id===id);setSelected(prev=>result?.source==='ipspos'?[id]:Array.from(new Set([id,...prev])).slice(0,4));navigate('analysis');};

  const running=snapshot.tasks.filter(t=>t.status==='running'||t.status==='queued').length;
  const logs=snapshot.logs.filter(l=>logFilter==='all'||(logFilter==='errors'&&l.level==='error')||l.taskId===logFilter).slice(-200).reverse();
  const taskItem=(t:Task)=><div className="console-task" key={t.id}><Tag color={statusColors[t.status]}>{statusText[t.status]}</Tag><span>{t.name}</span><span className="mono">{t.progress}%</span><span className="subtle">{t.error||t.request.config.mode}</span>{t.status==='succeeded'?(snapshot.results.some(r=>r.id===t.resultId)?<Button type="link" size="small" onClick={()=>openResult(t.resultId!)}>查看结果</Button>:<span className="subtle">缓存已清理</span>):['queued','running'].includes(t.status)?<Button type="link" size="small" danger onClick={()=>engine.cancelTask(t.id)}>取消</Button>:null}</div>;
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#" onClick={e=>{e.preventDefault();navigate('monitor');}}><img src={mark}/><div><strong>FINDU</strong><small>GNSS WORKBENCH</small></div></a><div className="workspace-label">工作空间 <span>WORKSPACE</span></div>
      <nav aria-label="主导航">{navigation.map(n=><button key={n.id} className={`nav-item ${page===n.id?'active':''}`} onClick={()=>navigate(n.id)}>{n.icon}<span>{n.label}<small>{n.english}</small></span>{page===n.id&&<i/>}</button>)}</nav>
      <div className="sidebar-bottom">{isDesktop()&&<Button type="text" size="small" block onClick={()=>{const next=!showDemo;setShowDemo(next);persist('showDemo',next);if(!next){setMonitorMode('real');setPostMode('real');engine.stopLive();}}}>{showDemo?'隐藏开发演示':'开发演示入口'}</Button>}<div className="engine-card"><div><span className="engine-orb"/>IPSPOS 引擎 <Tooltip title={engineInfo?.buildId}><Tag bordered={false}>{engineInfo?.version||(isDesktop()?"未连接":"界面预览")}</Tag></Tooltip></div><p>{isDesktop()?'实时 / 后处理 / 文件回放':'浏览器界面预览'}</p><small>实时最多 5 路 · 后处理最多 32 路</small></div><div className="sidebar-version"><span>FINDU 0.7.5</span><span>WINDOWS</span></div></div>
    </aside>
    <div className="app-main"><header className="topbar"><div className="breadcrumb"><DashboardOutlined/><span>工作台</span><span className="slash">/</span><strong>{navigation.find(n=>n.id===page)?.label}</strong></div><Space size={18}><span className="runtime"><span className="tiny-dot"/>{isDesktop()?'Windows 桌面':'浏览器预览'}</span>{page==='config'?<Tag color="blue">产品准备</Tag>:(page==='monitor'&&monitorMode==='real')||(page==='post'&&postMode==='real')||(page==='analysis'&&snapshot.results.some(r=>selected.includes(r.id)&&r.source!=='mock'))?<Tag color="green">真实解算 / 分析</Tag>:<Tag className="mock-badge">模拟模式</Tag>}<Tooltip title="桌面支持真实实时会话与后处理；浏览器可预览界面"><span className="top-info">LOCAL WORKSPACE</span></Tooltip></Space></header>
      <Splitter vertical className="workspace-split" onResizeEnd={sizes=>{if(!collapsed)persist('consoleHeight',Math.round(sizes[1]));}}>
        <Splitter.Panel min={350}><main className="workspace-content">{page==='monitor'?<><div className="post-modebar"><Space><Button size="small" type={monitorMode==='real'?'primary':'default'} onClick={()=>setMonitorMode('real')}>IPSPOS 实时解算</Button>{showDemo&&<Button size="small" type={monitorMode==='demo'?'primary':'default'} onClick={()=>setMonitorMode('demo')}>模拟监控</Button>}</Space></div>{monitorMode==='real'?<RealtimeWorkspace snapshot={snapshot} onResults={ids=>{setSelected(ids);navigate('analysis');}}/>:<Monitor snapshot={snapshot} service={engine}/>}</>:page==='post'?<><div className="post-modebar"><Space><Button size="small" type={postMode==='real'?'primary':'default'} onClick={()=>setPostMode('real')}>IPSPOS 真实解算</Button>{showDemo&&<Button size="small" type={postMode==='demo'?'primary':'default'} onClick={()=>setPostMode('demo')}>模拟演示</Button>}</Space><span className="subtle">真实任务与演示任务明确区分</span></div>{postMode==='real'?<NativePostProcess snapshot={snapshot} onResult={openResult} documents={nativeDocuments} setDocuments={setNativeDocuments}/>:<PostProcess snapshot={snapshot} service={engine} templates={templates} onResult={openResult}/>}</>:page==='config'?<DataDownloads onPrepared={docs=>{setNativeDocuments(prev=>[...docs,...prev.filter(p=>!docs.some(d=>p.sourcePath===d.sourcePath))]);setPostMode('real');navigate('post');}}/>:<Analysis results={snapshot.results} selected={selected} onSelected={setSelected}/>}</main></Splitter.Panel>
        <Splitter.Panel defaultSize={initialConsole} min={collapsed?38:110} max={collapsed?38:360} size={collapsed?38:undefined} resizable={!collapsed}>
          <section className={`console ${collapsed?'collapsed':''}`}><div className="console-bar"><Tabs size="small" activeKey={consoleTab} onChange={setConsoleTab} items={[{key:'logs',label:<><CodeOutlined/> 运行日志 <span className="tab-count">{snapshot.logs.length}</span></>},{key:'tasks',label:<>任务队列 <span className="tab-count">{running}</span></>}]}/><div className="console-controls">{consoleTab==='logs'&&!collapsed&&<Select aria-label="筛选日志" size="small" value={logFilter} onChange={setLogFilter} style={{width:170}} options={[{value:'all',label:'全部日志'},{value:'errors',label:'仅错误日志'},...snapshot.tasks.map(t=>({value:t.id,label:t.name}))]}/>}<span className="subtle">UTC</span><Button size="small" type="text" aria-label={collapsed?'展开日志面板':'折叠日志面板'} icon={collapsed?<UpOutlined/>:<DownOutlined/>} onClick={()=>{setCollapsed(!collapsed);persist('consoleCollapsed',!collapsed);}}/></div></div>
          {!collapsed&&<div className="console-content">{consoleTab==='logs'?(logs.length?logs.map(l=><div className={`log-line ${l.level}`} key={l.id}><time>{utcLabel(l.time)}</time><span className="log-level">{l.level.toUpperCase()}</span><span>{l.message}</span>{l.taskId&&<span className="log-task">#{l.taskId.slice(0,8)}</span>}</div>):<div className="console-empty">没有匹配的日志</div>):snapshot.tasks.length?snapshot.tasks.map(taskItem):<div className="console-empty">暂无任务，前往后处理导入 OPT 创建任务</div>}</div>}
          </section>
        </Splitter.Panel>
      </Splitter>
      <footer className="statusbar"><div><CheckCircleOutlined className="mint"/> 工作台就绪 <span className="status-divider"/> {snapshot.realtimeSessions?.some(s=>['starting','running','stopping'].includes(s.state))?`实时解算运行中 ${snapshot.realtimeSessions.filter(s=>['starting','running','stopping'].includes(s.state)).length} 路`:snapshot.live.running?'模拟数据流运行中':'数据流未运行'}</div><div>待处理任务 {running}<span className="status-divider"/>结果集 {snapshot.results.length}<span className="status-divider"/>坐标单位 m · UTC</div></footer>
    </div>
  </div>;
}
export default function App() {return <ConfigProvider locale={zhCN} theme={{algorithm:theme.darkAlgorithm,token:{colorPrimary:'#659fff',colorSuccess:'#45d6b0',colorInfo:'#659fff',colorWarning:'#ecb65c',colorError:'#f27d90',colorBgBase:'#10141c',colorBgContainer:'#161d28',colorBorder:'#303b4e',colorText:'#dce5f2',colorTextSecondary:'#8b9aaf',borderRadius:10,fontSize:14,fontFamily:'"Segoe UI", "Microsoft YaHei", sans-serif'},components:{Table:{headerBg:'#1c2533',rowHoverBg:'#1e2a3b',cellPaddingBlockSM:13},Tabs:{horizontalMargin:'0'},Button:{primaryShadow:'none'},Select:{optionSelectedBg:'#263e61'}}}}><AntApp><Workbench/></AntApp></ConfigProvider>;}




