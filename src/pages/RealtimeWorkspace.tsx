import capacity from '../../contracts/capacity.json';
import {realtimeDisplay} from '../services/realtime-display';
import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {App,Button,Input,Select,Space,Table,Tag,Tooltip} from 'antd';
import {FolderOpenOutlined,PlusOutlined,UploadOutlined} from '@ant-design/icons';
import type {RealtimeDocument,RealtimeSnapshot,WorkbenchSnapshot} from '../../contracts';
import RealtimeMonitor,{seedRealtimeDraft,realtimeDraftRequest} from './RealtimeMonitor';
import {workbenchEngine} from '../services/native-engine';
import {forgetRealtimeDraft} from '../services/realtime-drafts';
import {isDesktop} from '../services/files';
import {useOptDrop} from '../services/opt-drop';
import {sessionName,compactSessionName,nextOrdinal} from '../services/session-names';
import {Metric,PageHeading,Panel,SolutionTag} from '../components/common';
import '../realtime-workspace.css';
type Pending={key:string;label:string;station:string;sourcePath:string};
type Row=Pending&{snapshot?:RealtimeSnapshot};
let savedPending:Pending[]=[];let savedFocus='';let savedChecked:string[]=[];
const active=(s?:RealtimeSnapshot)=>s&&['starting','running','stopping'].includes(s.state);
const states={idle:'待启动',starting:'正在启动',running:'运行中',stopping:'正在停止',stopped:'已停止',failed:'失败'};
const metric=(s:RealtimeSnapshot|undefined,k:string,now:number,d=0)=>{const value=realtimeDisplay(s,now).metrics?.[k];return typeof value==='number'&&Number.isFinite(value)?value.toFixed(d):'—';};
export default function RealtimeWorkspace({snapshot,onResults}:{snapshot:WorkbenchSnapshot;onResults:(ids:string[])=>void}){
 const {message}=App.useApp();const [pending,setPendingState]=useState(savedPending);const [focus,setFocusState]=useState(savedFocus);const [checked,setCheckedState]=useState(savedChecked);const [paths,setPaths]=useState('');const [busy,setBusy]=useState(false);const [filter,setFilter]=useState('all');
 const setPending=(p:Pending[])=>{savedPending=p;setPendingState(p);};const setChecked=(ids:string[])=>{savedChecked=ids;setCheckedState(ids);};
 const sessions=snapshot.realtimeSessions??[];const rows:Row[]=[...sessions.map(s=>({key:s.sessionKey,label:s.label||s.configName,station:s.station||'未指定测站',sourcePath:s.sourcePath,snapshot:s})),...pending.filter(p=>!sessions.some(s=>s.sessionKey===p.key))];
 const focusKey=focus==='__new__'?'__new__':rows.some(r=>r.key===focus)?focus:rows[0]?.key||'__new__';
 const chosen=rows.find(r=>r.key===focusKey);const detail=snapshot.realtime?.sessionKey===focusKey&&snapshot.realtime.id===chosen?.snapshot?.id?snapshot.realtime:chosen?.snapshot;
 const [now,setNow]=useState(()=>Date.now()/1000);
 const running=sessions.filter(active).length;
 useEffect(()=>{if(!running)return;setNow(Date.now()/1000);const timer=setInterval(()=>setNow(Date.now()/1000),1000);return()=>clearInterval(timer);},[running]);const selected=rows.filter(r=>checked.includes(r.key));
 const select=(key:string)=>{savedFocus=key;setFocusState(key);workbenchEngine.selectLive(key);};
 const started=(key:string)=>{setPending(pending.filter(p=>p.key!==key));select(key);};
 const load=async(list:string[])=>{if(list.length+rows.length>capacity.realtimeRecords){message.warning(`最多保留 ${capacity.realtimeRecords} 路配置与会话，请先移除已结束记录`);return;}setBusy(true);try{const docs=await Promise.all(list.map(path=>invoke<RealtimeDocument>('import_realtime',{path})));const firstOrdinal=nextOrdinal(rows.map(r=>r.label));const incoming=docs.map((doc,i)=>{const key=`plan-${crypto.randomUUID()}`;const label=sessionName(doc.name,firstOrdinal+i);seedRealtimeDraft(key,doc,label);return{key,label,station:doc.values.ROVE_NTRIP_Mountpoint||'未指定测站',sourcePath:doc.sourcePath};});setPending([...pending,...incoming]);setChecked([...checked,...incoming.map(p=>p.key)]);if(incoming[0])select(incoming[0].key);message.success(`已载入 ${incoming.length} 路配置，请核对测站分组与参数后启动`);}catch(e){message.error(String(e));}finally{setBusy(false);}};
 const {ref:dropRef,dragging}=useOptDrop(load);
 const batchStart=async()=>{setBusy(true);let count=0;const startedKeys:string[]=[];try{for(const row of selected.filter(r=>!active(r.snapshot))){const request=await realtimeDraftRequest(row.key);if(!request){message.warning(`请先打开 ${row.label} 核对配置`);continue;}try{await invoke('start_realtime',{sessionId:row.key,request});count++;startedKeys.push(row.key);}catch(e){message.error(`${row.label}：${String(e)}`);}}if(count){setPending(pending.filter(p=>!startedKeys.includes(p.key)));select(startedKeys[0]);message.success(`已启动 ${count} 路；每路独立执行`);}}finally{setBusy(false);}};
 const stop=async(key:string)=>{try{await invoke('stop_realtime',{sessionId:key});}catch(e){message.error(String(e));}};
 const remove=async(row:Row)=>{try{if(row.snapshot)await workbenchEngine.removeLive(row.key);forgetRealtimeDraft(row.key);setPending(pending.filter(p=>p.key!==row.key));setChecked(checked.filter(k=>k!==row.key));if(focusKey===row.key)select('__new__');}catch(e){message.error(String(e));}};
 const compare=async()=>{const selectedSessions=selected.filter(r=>r.snapshot&&r.snapshot.solutionMode!=='RECORD');if(selectedSessions.length>capacity.comparisonResults){message.warning(`一次最多对比 ${capacity.comparisonResults} 路方案，请调整勾选`);return;}if(new Set(selectedSessions.map(r=>r.station)).size>1){message.warning('实时对比请勾选同一测站的方案；不同测站可在总览中同时监控');return;}try{const ids=await workbenchEngine.compareLive(selectedSessions.map(r=>r.key));if(!ids.length){message.warning('所选会话尚无有效定位，继续接收后再对比');return;}if(ids.length<selectedSessions.length)message.warning('部分会话尚无有效定位，先展示已有结果');onResults(ids);}catch(e){message.error(String(e));}};
 const fullAnalysis=async(row:Row)=>{try{const ids=await workbenchEngine.importResults([row.snapshot!.outputDir]);onResults(ids);}catch(e){message.error(String(e));}};
 const strip=useRef<HTMLDivElement>(null);const [nameBudget,setNameBudget]=useState(24);useEffect(()=>{if(!strip.current)return;const observer=new ResizeObserver(e=>setNameBudget(Math.max(10,Math.floor((e[0].contentRect.width/5-42)/7.8))));observer.observe(strip.current);return()=>observer.disconnect();},[]);
 const configured=(key:string,doc:RealtimeDocument,label:string,station:string)=>{setPending(pending.map(p=>p.key===key?{...p,label,station,sourcePath:doc.sourcePath}:p));};
 const displayed=rows.filter(r=>filter==='all'||r.station===filter);
 return <div ref={dropRef} className="page multi-live">{dragging&&<div className="opt-drop-overlay">松开以添加实时方案 · 支持多个 OPT</div>}<PageHeading eyebrow="MULTI-SESSION MONITOR" title="实时工作区" description="同站不同产品与参数同时运行，也可按测站分组监控；每路独立配置、进程与结果目录。" actions={<Space><Button icon={<PlusOutlined/>} onClick={()=>select('__new__')}>新建方案</Button><Button icon={<UploadOutlined/>} disabled={!isDesktop()||busy} onClick={async()=>{try{const {open}=await import('@tauri-apps/plugin-dialog');const p=await open({multiple:true,filters:[{name:'IPSClient OPT',extensions:['opt']}]});if(p)await load(Array.isArray(p)?p:[p]);}catch(e){message.error(String(e));}}}>导入多个 OPT</Button></Space>}/>
 <div className="metrics metrics-four"><Metric label="正在运行" value={running} detail={`最多 ${capacity.realtimeRuns} 路同时运行`}/><Metric label="配置与会话" value={rows.length} detail={`最多保留 ${capacity.realtimeRecords} 路记录`}/><Metric label="测站分组" value={new Set(rows.map(r=>r.station)).size} detail="同一物理站点使用相同组名"/><Metric label="已有定位" value={sessions.filter(s=>s.bufferedEpochs>0).length} detail="各路最多缓存最近 3600 历元"/></div>
 <div className="live-session-selector" ref={strip} role="group" aria-label="实时方案切换">{rows.map(r=><Tooltip key={r.key} title={`${r.label} · ${r.sourcePath}`}><button className={r.key===focusKey?'active':''} aria-label={`切换 ${r.label}`} aria-pressed={r.key===focusKey} onClick={()=>select(r.key)}><i className={active(r.snapshot)?'mint-dot':'blue-dot'}/><span>{compactSessionName(r.label,nameBudget)}</span></button></Tooltip>)}</div>
 <Panel title="实时会话总览" extra={<Space><Select aria-label="实时测站筛选" value={filter} onChange={setFilter} style={{minWidth:140}} options={[{value:'all',label:'全部测站'},...[...new Set(rows.map(r=>r.station))].map(value=>({value,label:value}))]}/><Button disabled={!sessions.some(active)} danger onClick={()=>void invoke('stop_all_realtime').catch(e=>message.error(String(e)))}>停止全部</Button></Space>}>
 <div className="multi-live-import"><Input aria-label="多路实时 OPT 路径" value={paths} onChange={e=>setPaths(e.target.value)} placeholder="拖入多个 OPT，或粘贴路径，多个用 | 分隔"/><Button disabled={!isDesktop()||!paths.trim()||busy} loading={busy} onClick={()=>load(paths.split('|').map(p=>p.trim()).filter(Boolean))}>载入方案</Button></div>
 <Table<Row> size="small" rowKey="key" dataSource={displayed} pagination={{pageSize:6,hideOnSinglePage:true}} scroll={{x:1350}} rowClassName={r=>r.key===focusKey?'selected-live-row':''} rowSelection={{selectedRowKeys:checked,onChange:keys=>setChecked(keys.map(String))}} columns={[
 {title:'方案 / 测站',fixed:'left',width:200,render:(_,r)=><div className="live-row-name"><Tooltip title={`${r.label} · ${r.sourcePath}`}><strong>{compactSessionName(r.label,nameBudget)}</strong></Tooltip><small>{r.station}</small></div>},
 {title:'运行状态',width:110,render:(_,r)=><Tag color={r.snapshot?.state==='failed'?'error':active(r.snapshot)?'processing':'default'}>{states[r.snapshot?.state??'idle']}</Tag>},
 {title:'解状态',width:90,render:(_,r)=>r.snapshot?.solutionMode==='RECORD'?<Tag color='cyan'>仅录制</Tag>:<Tooltip title={realtimeDisplay(r.snapshot,now).epochDetail}><span><SolutionTag value={realtimeDisplay(r.snapshot,now).solution}/></span></Tooltip>},
 {title:'观测 / 支持 / 使用',width:155,render:(_,r)=>`${metric(r.snapshot,'Obs',now)} / ${metric(r.snapshot,r.snapshot?.solutionMode==='RTK'?'Com':'OC',now)} / ${metric(r.snapshot,'FloUse',now)}`},
 {title:'HDOP / 搜索 Ratio',width:130,render:(_,r)=>`${metric(r.snapshot,'HDOP',now,2)} / ${metric(r.snapshot,'Ratio',now,2)}`},
 {title:'产品 / 连接',width:140,render:(_,r)=>{const streams=r.snapshot?.heartbeat?.streams??[];return <span>{(r.snapshot?.productType==='RECORD'?'原始数据':r.snapshot?.productType)||'待配置'} · {streams.filter(s=>s.state===2).length}/{streams.length} 已连接</span>;}},
 {title:'更新 / 已读历元',width:155,render:(_,r)=><Tooltip title={r.snapshot?.error||r.snapshot?.parseError||r.sourcePath}><span>{r.snapshot?.solutionMode==='RECORD'?`${((r.snapshot.heartbeat?.streams??[]).reduce((n,s)=>n+s.bytes,0)/1048576).toFixed(2)} MiB / ${r.snapshot.recordingFiles?.length??0} 文件`:`${r.snapshot?.logUpdatedAt?.slice(11,19)||'—'} / ${r.snapshot?.receivedEpochs??0}`}</span></Tooltip>},
 {title:'操作',width:320,render:(_,r)=><Space wrap><Button size="small" type="link" onClick={()=>select(r.key)}>详情 / 配置</Button>{active(r.snapshot)?<Button size="small" type="link" danger onClick={()=>stop(r.key)}>停止</Button>:<Button type="link" size="small" onClick={()=>remove(r)}>移除</Button>}{r.snapshot?.outputDir&&<Button type="link" size="small" icon={<FolderOpenOutlined/>} onClick={()=>void invoke('open_live_folder',{sessionId:r.key}).catch(e=>message.error(String(e)))}>目录</Button>}{!active(r.snapshot)&&r.snapshot?.solutionMode!=='RECORD'&&r.snapshot?.logPath&&<Button type="link" size="small" onClick={()=>fullAnalysis(r)}>完整结果分析</Button>}</Space>},
 ]}/>
 <div className="multi-live-actions"><Space><Button aria-label="启动所选方案" type="primary" disabled={!isDesktop()||busy||!selected.some(r=>!active(r.snapshot))} loading={busy} onClick={batchStart}>启动所选方案</Button><Button disabled={!selected.some(r=>active(r.snapshot))} onClick={async()=>{for(const row of selected.filter(r=>active(r.snapshot)))await stop(row.key);}}>停止所选</Button><Button disabled={!selected.some(r=>r.snapshot&&r.snapshot.solutionMode!=='RECORD')} onClick={compare}>实时对比所选</Button></Space><span>单路停止或失败不影响其它会话；移除记录保留磁盘文件。</span></div>
 </Panel>
 <RealtimeMonitor key={focusKey} sessionKey={focusKey==='__new__'?undefined:focusKey} nameOrdinal={Number(chosen?.label.match(/^([0-9]+)_/)?.[1])||nextOrdinal(rows.map(r=>r.label))} onConfigured={configured} snapshot={detail} onStarted={started} handleDrop={false}/>
 </div>;
}
