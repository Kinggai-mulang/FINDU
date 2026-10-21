import {memo,useMemo,useState} from 'react';
import {Button,Segmented,Space,Table,Tag,Tooltip} from 'antd';
import type {ResultSet,Solution} from '../../contracts';
import {format,type Window} from '../analysis';
import {arEnabled,fieldInfo,geometryDiagnostics,numeric,solverMode,stateSegments} from '../diagnostics';
import {DiagnosticChart} from './DiagnosticChart';
import {Panel,NoData} from './common';
import {solutionColor} from './chart-data';
import '../diagnostics.css';

export type DiagnosticProps={results:ResultSet[];timeDomain?:Window;onTimeRange?:(start:number,end:number)=>void;onInspect?:(time:number)=>void};
export function DiagnosticPanel({title,fields,unit='',scale=1,reading,bounds,states,note,...props}:DiagnosticProps&{title:string;fields:string[];unit?:string;scale?:number;reading?:[number,number];bounds?:[number,number];states?:Record<number,string>;note?:string;labels?:Record<string,string>}){
 const [focused,setFocused]=useState(false);const info=fields.length===1?fieldInfo[fields[0]]:undefined;
 return <Panel className="diagnostic-panel" title={title} extra={<Space size={8}>{info&&<Tooltip title={info.note}><span className="diagnostic-help">说明</span></Tooltip>}{reading&&<Segmented size="small" aria-label={`${title} 显示范围`} value={focused?'reading':'full'} onChange={v=>setFocused(v==='reading')} options={[{value:'full',label:'全量程'},{value:'reading',label:'阅读窗'}]}/>}</Space>}>
  <DiagnosticChart datasets={props.results} fields={fields} label={title} unit={unit} valueScale={scale} displayBounds={focused?reading:bounds} states={states} {...props}/>
  {(note||info?.note)&&<div className="chart-note">{note??info?.note}</div>}
 </Panel>;
}

const qNames:Record<number,string>={0:'无解',1:'SPP',2:'SPP EKF',3:'预测',4:'码解',5:'浮点',6:'部分固定',7:'固定'};
const qSolutions:Record<number,Solution>={0:'NONE',1:'SPP',2:'SPP_EKF',3:'PRE',4:'CODE',5:'FLOAT',6:'FLOFIX',7:'FIX'};
const acNames:Record<number,string>={0:'未进入',1:'条件不足',2:'未通过',3:'确认中',4:'成功'};
const acColors=['#728199','#a996d5','#f07891','#e5be62','#58d8af'];
export const StateRibbon=memo(function StateRibbon({results,timeDomain,onInspect}:DiagnosticProps){
 const data=useMemo(()=>results.map(r=>({result:r,q:stateSegments(r.diagnostics??[],'Q'),ac:arEnabled(r)?stateSegments(r.diagnostics??[],'AC'):[]})),[results]);
 const times=useMemo(()=>data.flatMap(r=>[...r.q,...r.ac].flatMap(s=>[s.start,s.end])),[data]);
 if(!times.length)return null;
 const start=timeDomain?.start??times.reduce((a,b)=>Math.min(a,b)),end=timeDomain?.end??times.reduce((a,b)=>Math.max(a,b));const span=Math.max(end-start,1000);
 const qValues=[...new Set(data.flatMap(r=>r.q.map(s=>s.value)))].sort((a,b)=>a-b);
 const acValues=[...new Set(data.flatMap(r=>r.ac.map(s=>s.value)))].sort((a,b)=>a-b);
 const segments=(values:ReturnType<typeof stateSegments>,key:'Q'|'AC')=>values.map((m,i)=>{
  const at=Math.max(start,m.start),until=Math.min(end,m.end);if(until<start||at>end)return null;
  const name=(key==='Q'?qNames:acNames)[m.value]??String(m.value);const color=key==='Q'?solutionColor(m.solution):acColors[m.value];
  return <button key={`${at}:${i}`} type="button" aria-label={`${key} ${name} ${new Date(at).toISOString()}`} title={`${new Date(at).toISOString()} → ${new Date(until).toISOString()} · ${key} ${name}`} style={{left:`${(at-start)/span*100}%`,width:`${Math.max(.12,(until-at)/span*100)}%`,background:color}} onClick={()=>onInspect?.(at)}/>;
 });
 return <div className="state-ribbons"><div className="ribbon-caption"><strong>发布状态与 AR 处理</strong><span>固定包含 FIX / HOLD · 空白为缺测或时间缺口</span></div>{data.map(({result:r,q,ac})=><div className="state-ribbon" key={r.id}>
  <div className="ribbon-result" title={r.name}>{r.name}</div>
  <div className="ribbon-row"><Tooltip title="Q 表示本历元最终发布的定位解状态；与本次 AR 尝试是否通过分别记录。"><span className="ribbon-label">定位解状态 <b>Q</b></span></Tooltip><div className="ribbon-track" aria-label={`${r.name} Q 状态带`}>{segments(q,'Q')}</div></div>
  {arEnabled(r)?<div className="ribbon-row"><Tooltip title="AC 表示本历元 AR 处理状态：0 未进入、1 条件不足、2 未通过、3 确认中、4 成功。未通过时仍可发布浮点定位。"><span className="ribbon-label">AR 处理状态 <b>AC</b></span></Tooltip><div className="ribbon-track" aria-label={`${r.name} AC 状态带`}>{segments(ac,'AC')}</div></div>:<div className="ribbon-disabled"><strong>AR 处理状态 AC</strong><span>本次配置关闭 AR（GNSS_ARMode=0），未执行固定处理。</span></div>}
 </div>)}<div className="ribbon-legends"><div className="ribbon-legend"><strong>Q · 定位解状态</strong>{qValues.map(v=><span key={v}><i style={{background:solutionColor(qSolutions[v]??'NONE')}}/>{qNames[v]??v}</span>)}</div>
 {acValues.length>0&&<div className="ribbon-legend"><strong>AC · AR 处理状态</strong>{acValues.map(v=><span key={v}><i style={{background:acColors[v]}}/>{acNames[v]??v}</span>)}</div>}</div></div>;
},(a,b)=>a.results===b.results&&a.timeDomain?.start===b.timeDomain?.start&&a.timeDomain?.end===b.timeDomain?.end&&a.onInspect===b.onInspect);

export function ObservationDiagnostics(props:DiagnosticProps){
 const native=useMemo(()=>props.results.filter(r=>['PPP','RTK'].includes(solverMode(r))),[props.results]);const ppp=useMemo(()=>native.filter(r=>solverMode(r)==='PPP'),[native]),rtk=useMemo(()=>native.filter(r=>solverMode(r)==='RTK'),[native]);
 return <div className="solver-diagnostics">{!native.length&&<NoData text="载入 PPP 或 RTK Log=4 后查看观测诊断"/>}
  {ppp.length>0&&<DiagnosticPanel {...props} results={ppp} title="PPP 观测与产品支持" fields={['Obs','OC','IFBSup']} unit="颗" note="Obs 为观测，OC 在高度角筛选前；产品支持不等于最终进入更新。"/>}
  {rtk.length>0&&<><div className="diagnostic-intro"><Tag color="blue">RTK · 共视与差分</Tag><p>各阶段按原生口径展示；DDS 不含参考端，FloUse 包含参考端，计数不构成严格递减漏斗。</p></div><div className="diagnostic-grid">
   <DiagnosticPanel {...props} results={rtk} title="观测与共同卫星" fields={['Obs','Com']} unit="颗"/>
   <DiagnosticPanel {...props} results={rtk} title="非差支持 UDS" fields={['UDS']} unit="颗"/>
   <DiagnosticPanel {...props} results={rtk} title="单差支持 SDS" fields={['SDS']} unit="颗"/>
   <DiagnosticPanel {...props} results={rtk} title="双差目标 DDS" fields={['DDS']} unit="颗"/>
  </div></>}
  <div className="diagnostic-grid"><DiagnosticPanel {...props} title="进入与接受更新" fields={['FloIn','FloUse']} unit="颗"/>
   <DiagnosticPanel {...props} title="浮点几何" fields={['HDOP','VDOP']}/>
   <DiagnosticPanel {...props} title="滤波与模糊度重置" fields={['FltR','AmbR']} unit="次" note="AmbR 包含初始化；事件数不能当作跨历元去重数量。"/>
   <DiagnosticPanel {...props} title="周跳与观测拒绝" fields={['SlS','SlL','PRj','LRj']} unit="次" note="卫星、信号和观测行口径不同，集合可能重叠，不能相加。RTK 为流动站诊断。"/>
  </div>
 </div>;
}

export function AmbiguityDiagnostics(props:DiagnosticProps){
 const enabled=useMemo(()=>props.results.filter(arEnabled),[props.results]);const off=useMemo(()=>props.results.filter(r=>!arEnabled(r)),[props.results]);
 return <div className="solver-diagnostics">{off.length>0&&<div className="diagnostic-intro"><Tag>AR 关闭</Tag><p>{off.map(r=>r.name).join('、')} 的 GNSS_ARMode=0；本次未计算 Ratio、ADOP、候选／搜索约束和候选残差。下方保留日志实际记录的定位状态与发布计数。</p></div>}
  <StateRibbon {...props}/>{enabled.length>0&&<><div className="diagnostic-grid">
   <Panel title="AR Ratio"><DiagnosticChart datasets={enabled} fields={['Ratio']} label="AR Ratio" {...props}/></Panel>
   <Panel title="模糊度 DOP"><DiagnosticChart datasets={enabled} fields={['ADOP']} label="模糊度 DOP" unit="cycle" logarithmic {...props}/></Panel>
  </div><div className="diagnostic-intro"><p>以下按独立约束数分行：候选 → 搜索 → 单历元接受 → 发布。时间确认与最终发布分别核查；各阶段不是必然嵌套集合。</p></div>
  <div className="diagnostic-grid">{[['CanA','候选约束'],['SchA','参与搜索'],['InstA','单历元接受']].map(([key,title])=><DiagnosticPanel {...props} results={enabled} key={key} title={title} fields={[key]} unit="个约束"/>)}</div>
  <div className="diagnostic-grid"><DiagnosticPanel {...props} results={enabled} title="候选卫星" fields={['CanS']} unit="颗"/>
   <DiagnosticPanel {...props} results={enabled} title="跨频一致性 PCR" fields={['PCR']} unit="mm" scale={1000}/>
   <DiagnosticPanel {...props} results={enabled} title="候选伪距残差" fields={['APRMS']} unit="m"/>
   <DiagnosticPanel {...props} results={enabled} title="候选相位残差" fields={['ALRMS']} unit="mm" scale={1000}/>
   <DiagnosticPanel {...props} results={enabled} title="模糊度差异 ADR" fields={['ADR']} unit="cycle"/>
  </div></>}<div className="diagnostic-grid"><DiagnosticPanel {...props} title="最终发布约束" fields={['FixA']} unit="个约束"/><DiagnosticPanel {...props} title="最终发布卫星" fields={['FixS']} unit="颗"/></div>
 </div>;
}

export function BaseDiagnostics(props:DiagnosticProps){
 const results=useMemo(()=>props.results.filter(r=>solverMode(r)==='RTK').map(geometryDiagnostics),[props.results]);
 if(!results.length)return <NoData text="基站与同步仅用于 RTK 结果"/>;
 const rows=results.map(r=>{const valid=(r.diagnostics??[]).filter(m=>['BaseX','BaseY','BaseZ'].every(k=>numeric(m,k)!==null));const latest=valid.at(-1);const coordinates=new Set(valid.map(m=>[m.BaseX,m.BaseY,m.BaseZ].join(',')));return{id:r.id,name:r.name,latest,coordinates:coordinates.size};});
 return <div className="solver-diagnostics"><div className="diagnostic-intro"><Tag color="blue">RTK · 基站与同步</Tag><p>观测时差和接收停滞分别观察。移动基线重点核查相对几何，静态模型不能替代接收机实际运动状态。</p></div>
  <div className="diagnostic-grid"><DiagnosticPanel {...props} results={results} title="流动站与基站观测时差" fields={['BRAge']} unit="s"/>
   <DiagnosticPanel {...props} results={results} title="两端解算坐标间距" fields={['Baseline']} unit="m"/>
   <DiagnosticPanel {...props} results={results} title="基线向量 · 基站局部 ENU" fields={['BaselineE','BaselineN','BaselineU']} unit="m" note="由同历元两端坐标投影到当前基站的局部 ENU；与定位图的共用原点分别定义。"/>
   <DiagnosticPanel {...props} results={results} title="基站坐标相对变化" fields={['BaseMove']} unit="m" note="各方案相对当前窗口首个有效基站坐标的三维变化量，不能作为基站坐标误差；移动基站允许真实变化。"/>
  </div><Panel title="基站 ECEF 坐标"><Table size="small" rowKey="id" pagination={false} scroll={{x:760}} dataSource={rows} columns={[{title:'方案',dataIndex:'name'},...['BaseX','BaseY','BaseZ'].map(k=>({title:`${k} / m`,render:(_:unknown,r:typeof rows[number])=>format(r.latest?numeric(r.latest,k):null,3)})),{title:'已记录坐标组数',dataIndex:'coordinates'}]}/><div className="chart-note">坐标框架、参考点及天线偏心需核验；原生日志坐标变化不自动判作异常。基站逐历元完整卫星清单未由当前状态日志提供。</div></Panel>
 </div>;
}

export function VelocityDiagnostics(props:DiagnosticProps){
 const results=useMemo(()=>props.results.map(geometryDiagnostics),[props.results]);
 return <div className="solver-diagnostics"><div className="diagnostic-intro"><Tag>独立测速 VQ</Tag><p>按同历元流动站位置将引擎速度转换为东、北、天分量。VQ 与位置 Q 独立；预测速度不计有效测量速度，缺少当前位置时只保留有效速度模长。</p></div>
  <DiagnosticPanel {...props} results={results} title="测速来源与状态" fields={['VQ']} states={{0:'无测速',1:'预测',2:'多普勒',3:'TDCP',4:'融合预留'}} bounds={[0,4]}/>
  <div className="diagnostic-grid"><DiagnosticPanel {...props} results={results} title="ENU 速度分量" fields={['VE','VN','VU']} labels={{VE:'东向 VE',VN:'北向 VN',VU:'天向 VU'}} unit="m/s"/>
   <DiagnosticPanel {...props} results={results} title="水平与三维速度" fields={['Speed2D','Speed']} labels={{Speed2D:'水平速度',Speed:'三维速度'}} unit="m/s"/>
   <DiagnosticPanel {...props} title="测速卫星支持" fields={['DopS','TcpS']} unit="颗"/>
   <DiagnosticPanel {...props} title="测速观测行数" fields={['DopN','TcpN']} unit="行"/>
  </div>
 </div>;
}

export function EpochInspector({results,at,onClear}: {results:ResultSet[];at:number|null;onClear:()=>void}){
 if(at===null)return null;
 const rows=results.map(r=>({id:r.id,name:r.name,metric:r.diagnostics?.find(m=>Date.parse(m.time)===at)}));
 const fields=['Q','AC','Up','FloUse','OC','Com','ZWD','TrpSRMS','IonDRMS','ZWDUCor','IAC95','FltR','AmbR','SlL','PRj','LRj','Disc','BRAge'];
 return <Panel className="epoch-inspector" title="选中历元 · 同期证据" extra={<Button size="small" onClick={onClear}>取消选点</Button>}><div className="inspector-time">{new Date(at).toISOString()} · 按精确 UTC 查询，未记录的同历元保持未知</div>
  <Table size="small" rowKey="field" pagination={{pageSize:8,hideOnSinglePage:true}} scroll={{x:600}} dataSource={fields.filter(k=>rows.some(r=>r.metric?.[k]!==undefined)).map(field=>({field}))} columns={[{title:'字段 / 显示单位',width:220,render:(_,r)=>`${fieldInfo[r.field]?.name??r.field} ${fieldInfo[r.field]?.unit??''}`},...rows.map(r=>({title:r.name,render:(_:unknown,row:{field:string})=>{const value=r.metric?numeric(r.metric,row.field):null;return format(value===null?null:value*(fieldInfo[row.field]?.scale??1),fieldInfo[row.field]?.scale===1000?1:4);}}))]}/>
 </Panel>;
}

export function DataSources({results,live=false}:{results:ResultSet[];live?:boolean}){
 return <div className="solver-diagnostics"><div className="diagnostic-intro"><Tag color="blue">RTK · 数据源与同步</Tag><p>流动站与基站分别记录接收状态。接收时刻为本机 UTC；BRAge 为两站观测时差，两者分别核查。</p></div>{results.map(r=>{
  const streams=r.clientStatus?.streams??[];
  return <Panel title={r.name} key={r.id}><div className="source-summary-grid">{['ROVE','BASE'].map(role=>{
   const s=streams.find(v=>v.role===role);const path=r.analysisConfig?.[role==='ROVE'?'GNSS_RoveFile':'GNSS_BaseFile'];
   const name=role==='ROVE'?'流动站观测':'基站观测';
   const state=s?(['已关闭','连接中',s.lastArrival?'已接收数据':'连接成功 · 等待数据','连接错误'][s.state]??'未知'):path?'后处理文件':'未关联来源';
   const stale=live&&s?.state===2&&s.lastArrival>0&&Date.now()/1000-s.lastArrival>10;
   return <section className="source-summary-card" key={role}><header><strong>{name}</strong><Tag color={stale?'warning':s?.state===3?'error':s?.state===2?'success':'default'}>{stale?'接收停滞':state}</Tag></header>
    {s?<dl><dt>累计接收</dt><dd>{(s.bytes/1048576).toFixed(2)} MiB</dd><dt>完整 RTCM 帧</dt><dd>{s.frames}</dd><dt>最近实际到达</dt><dd>{s.lastArrival?new Date(s.lastArrival*1000).toISOString().slice(11,19)+' UTC':'—'}</dd><dt>重连 / 错误码</dt><dd>{s.reconnects} / {s.errorCode}</dd><dt>HTTP</dt><dd>{s.httpStatus||'—'}</dd></dl>:<p className="source-file-path">{path??'当前日志没有关联原始输入；不能据此核对两端输入覆盖或共同信号。'}</p>}
   </section>;
  })}</div>{r.analysisConfig?.GNSS_NaviFile&&<div className="chart-note source-file-path">导航输入：{r.analysisConfig.GNSS_NaviFile}</div>}
  <div className="chart-note">{live?'当前接收状态':'显示保存的状态快照／输入来源，不代表当前网络状态'}。累计帧数不等同于参与解算卫星数；原始文件覆盖审计后续单独提供。</div></Panel>;
 })}</div>;
}
