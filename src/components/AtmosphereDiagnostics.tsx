import {useMemo,useState} from 'react';
import {Button,Checkbox,Collapse,InputNumber,Segmented,Select,Space,Table,Tag} from 'antd';
import {atmosphereEvents,atmosphereStats,atmosphereWindowStats,geometryDiagnostics,solverMode,numeric} from '../diagnostics';
import {format} from '../analysis';
import {DiagnosticPanel,type DiagnosticProps} from './SolverDiagnostics';
import {Panel,NoData} from './common';

export function AtmosphereDiagnostics(props:DiagnosticProps){
 const [view,setView]=useState('estimate');const [common,setCommon]=useState(false);const [state,setState]=useState('all');const [threshold,setThreshold]=useState(20);const [bucket,setBucket]=useState('all');
 const results=useMemo(()=>props.results.filter(r=>solverMode(r)==='PPP').map(r=>view==='coupling'?geometryDiagnostics(r):r),[props.results,view]);
 const events=useMemo(()=>view==='events'?atmosphereEvents(results,threshold):[],[results,threshold,view]);
 const statsResults=results.map(r=>({...r,diagnostics:state==='all'?r.diagnostics:r.diagnostics?.filter(m=>state==='fixed'?['FIX','HOLD'].includes(m.solution):m.solution===state)}));
 const stats=useMemo(()=>view==='statistics'?(bucket==='30min'?atmosphereWindowStats(statsResults,common):atmosphereStats(statsResults,common).map(r=>({...r,window:'当前选定时段'}))):[],[results,state,common,view,bucket]);
 if(!results.length)return <NoData text="大气与状态耦合仅用于 PPP 结果"/>;
 const jump=(at:string)=>{const t=Date.parse(at);props.onTimeRange?.(Math.max(props.timeDomain?.start??-Infinity,t-60000),Math.min(props.timeDomain?.end??Infinity,t+60000));props.onInspect?.(t);};
 return <div className="solver-diagnostics atmosphere-diagnostics">
  <div className="diagnostic-intro"><div><Tag color="cyan">PPP · 浮点大气状态</Tag><strong>大气与状态耦合</strong></div><p>这些量采集于当前 AR / HOLD 前的接受浮点状态。形式不确定度和耦合不等于实际大气误差；最终固定标签仅用于分组。</p></div>
  <div className="diagnostic-subnav"><Segmented aria-label="大气分析分区" value={view} onChange={setView} options={[{value:'estimate',label:'状态与更新'},{value:'coupling',label:'状态耦合'},{value:'events',label:'事件核查'},{value:'statistics',label:'分布与统计'}]}/><span>图表共享观测时间 · 原始单位保留</span></div>
  {view==='estimate'&&<>
   <div className="diagnostic-grid"><DiagnosticPanel {...props} results={results} title="湿天顶延迟 ZWD" fields={['ZWD']} unit="mm" scale={1000}/>
    <DiagnosticPanel {...props} results={results} title="对流层形式不确定度" fields={['TrpSRMS']} unit="mm" scale={1000} reading={[0,5]}/>
   </div>
   <DiagnosticPanel {...props} results={results} title="电离层更新 RMS" fields={['IonDRMS']} unit="mm" scale={1000} reading={[0,20]}/>
   <Collapse ghost items={[{key:'dry',label:'干延迟模型与量纲说明',children:<><DiagnosticPanel {...props} results={results} title="干天顶延迟模型 ZHD" fields={['ZHD']} unit="m"/><p className="chart-note">ZWD、TrpSRMS、IonDRMS 原生日志记录分辨率为 0.1 mm；曲线小数位不代表实测精度。阅读窗只改变显示，统计、事件和原始导出保留全部有效样本。</p></>} ]}/>
  </>}
  {view==='coupling'&&<>
   <div className="diagnostic-grid"><DiagnosticPanel {...props} results={results} title="湿延迟与 Up 形式相关" fields={['ZWDUCor']} unit="ρ" bounds={[-1,1]}/>
    <DiagnosticPanel {...props} results={results} title="电离层—模糊度条件方差耦合" fields={['IAC50','IAC95']} unit="C" bounds={[0,1]} reading={[.9,1]} note="C50 / C95 为星间条件方差消减比例的中位数 / P95；全部接受模糊度已知时的形式量，不是实际 PAR 固定收益或固定成功率。"/>
    <DiagnosticPanel {...props} results={results} title="同历元 Up 位置变化" fields={['Up']} unit="m" note="使用当前分析参考／共用原点；未提供独立参考时只描述相对位置。"/>
    <DiagnosticPanel {...props} results={results} title="卫星支持与接受更新" fields={['OC','FloUse']} unit="颗"/>
   </div>
  </>}
  {view==='events'&&<><Panel title="电离层更新大值核查" extra={<Space><span className="subtle">显示阈值 / mm</span><InputNumber aria-label="电离层核查阈值" min={.1} value={threshold} onChange={v=>setThreshold(v??20)}/></Space>}>
   <div className="chart-note">默认 20 mm 仅用于定位核查，不删样本、不作物理异常门限。按连续段保留峰值；可改为 100 / 1000 mm 查看。</div>
   <Table size="small" rowKey="id" pagination={{pageSize:8,hideOnSinglePage:true}} scroll={{x:1100}} dataSource={events} columns={[
    {title:'方案',dataIndex:'name',width:170,ellipsis:true},{title:'峰值 UTC',dataIndex:'time',render:(v:string)=>v.replace('T',' ').replace('Z','')},
    {title:'峰值 / mm',dataIndex:'peak',render:(v:number)=>format(v,1)},{title:'连续历元',dataIndex:'n'},
    ...['FloUse','Q','AmbR','FltR','SlL','PRj','LRj','OC','Disc'].map(k=>({title:k,render:(_:unknown,r:typeof events[number])=>format(numeric(r.metric,k),0)})),
    {title:'核查',fixed:'right',width:105,render:(_,r)=><Button type="link" size="small" onClick={()=>jump(r.time)}>前后 60 秒</Button>},
   ]}/><div className="chart-note">这里只列同历元现象；没有 QC／重置变化时同样保留证据。当前汇总字段不足以定位异常卫星，不自动推断原因。</div>
  </Panel><DiagnosticPanel {...props} results={results} title="电离层更新与选定时段" fields={['IonDRMS']} unit="mm" scale={1000}/></>}
  {view==='statistics'&&<><Panel title="接受浮点样本 · 字段分布" extra={<Space wrap><Select aria-label="大气统计窗口" value={bucket} onChange={setBucket} options={[{value:'all',label:'当前时段'},{value:'30min',label:'30 分钟窗口'}]}/><Select aria-label="大气统计发布状态" value={state} onChange={setState} options={[{value:'all',label:'全部发布状态'},{value:'fixed',label:'FIX / HOLD'},{value:'FLOAT',label:'FLOAT'},{value:'FLOFIX',label:'FLOFIX'},{value:'CODE',label:'CODE'}]}/><Checkbox checked={common} disabled={results.length<2} onChange={e=>setCommon(e.target.checked)}>按字段有效交集</Checkbox></Space>}>
   <Table size="small" rowKey="id" pagination={{pageSize:14,hideOnSinglePage:true}} scroll={{x:1250}} dataSource={stats} columns={[
    {title:'方案',dataIndex:'name',width:170,ellipsis:true},{title:'窗口 UTC',dataIndex:'window',width:160},{title:'字段',dataIndex:'field',width:205},{title:'单位',dataIndex:'unit'},
    {title:'有效 / 接受更新',render:(_,r)=>`${r.n} / ${r.accepted}`},{title:'字段缺测',dataIndex:'missing'},{title:'实际零值',dataIndex:'zero'},
    ...(['min','median','p95','max'] as const).map((key,i)=>({title:['最小','中位数','时间 P95','最大'][i],render:(_:unknown,r:typeof stats[number])=>format(r[key],['mm'].includes(r.unit)?1:4)})),
   ]}/><div className="chart-note">只统计 Q4–8 的接受浮点样本；分状态使用最终发布标签。IAC95 的时间 P95 是对逐历元星间 P95 再做时间统计，不能解释为全星历元合并 P95。缺测不填 0；共同字段样本按 GPST 精确交集。</div>
  </Panel></>}
 </div>;
}
