import type {RealtimeMetrics,ResultSet} from '../contracts';
import {enuVelocity} from './velocity';
import {enu,estimateInterval,median,metricKey,quantile,type Cohort,type Window} from './analysis';

import {solverMode} from './domain';
export {solverMode,arEnabled} from './domain';
export const numeric=(m:RealtimeMetrics,key:string)=>typeof m[key]==='number'&&Number.isFinite(m[key])?m[key] as number:null;
export const accepted=(m:RealtimeMetrics)=>typeof m.Q==='number'?[4,5,6,7,8].includes(m.Q):['CODE','FLOAT','FLOFIX','FIX','HOLD'].includes(m.solution);
export const finalFixed=(m:RealtimeMetrics)=>m.solution==='FIX'||m.solution==='HOLD';

export const fieldInfo:Record<string,{name:string;unit:string;scale:number;note:string}>={
 Speed2D:{name:'水平速度',unit:'m/s',scale:1,note:'东、北速度的平面模长；缺少当前流动站位置时保持未知。'},
 Speed:{name:'三维速度',unit:'m/s',scale:1,note:'有效测量速度的三维模长；ECEF 与 ENU 模长一致。'},
 VE:{name:'东向速度',unit:'m/s',scale:1,note:'按同历元流动站位置旋转 ECEF 测量速度；原始 VX/VY/VZ 保留。'},
 VN:{name:'北向速度',unit:'m/s',scale:1,note:'当前流动站位置的局部北向速度。'},
 VU:{name:'天向速度',unit:'m/s',scale:1,note:'当前流动站位置的局部天向速度。'},
 ZWD:{name:'湿天顶延迟',unit:'mm',scale:1000,note:'浮点湿延迟状态；保留合法负值，不等同于模型湿延迟。'},
 ZHD:{name:'干天顶延迟模型',unit:'m',scale:1,note:'UNB3m 模型值，不是估计湿延迟。'},
 TrpSRMS:{name:'对流层形式不确定度',unit:'mm',scale:1000,note:'接受浮点卫星的对流层协方差传播 RMS，包含已启用的梯度；不是实测大气误差。'},
 IonDRMS:{name:'电离层更新 RMS',unit:'mm',scale:1000,note:'频率槽 0 的后验减本历元预测；排除新建、重置及基准变化样本，不是 TEC 或 ROTI。'},
 ZWDUCor:{name:'湿延迟与 Up 形式相关',unit:'ρ',scale:1,note:'有符号形式相关，局部 Up 不等于 ECEF Z；−1 是合法值。'},
 IAC50:{name:'电离层—模糊度耦合 C50',unit:'C',scale:1,note:'星间条件方差消减比例的中位数；使用全部接受相位模糊度，不代表实际固定子集的收益。'},
 IAC95:{name:'电离层—模糊度耦合 C95',unit:'C',scale:1,note:'星间条件方差消减比例的 P95；不是相关系数或固定成功率。'},
 Com:{name:'共同观测卫星',unit:'颗',scale:1,note:'筛选前共同卫星。'},
 UDS:{name:'非差支持卫星',unit:'颗',scale:1,note:'满足输入条件的流动站非差支持。'},
 SDS:{name:'单差支持卫星',unit:'颗',scale:1,note:'至少有一个共同信号被选择。'},
 DDS:{name:'双差目标卫星',unit:'颗',scale:1,note:'接受双差目标，不含参考端；FloUse 包含参考端。'},
 BRAge:{name:'两站观测时差',unit:'s',scale:1,note:'流动站与基站观测时间差的绝对值，不是网络延迟。'},
 Baseline:{name:'两端解算坐标间距',unit:'m',scale:1,note:'由同历元有效流动站与基站 ECEF 计算；不是已核验的基线真值。'},
 FPRMS:{name:'伪距后验 RMS',unit:'m',scale:1,note:'PPP 为非差、RTK 为双差行，不能直接跨模式排名。'},
 FLRMS:{name:'相位后验 RMS',unit:'mm',scale:1000,note:'显示值为原始米值 ×1000；原始导出仍使用 m。'},
 PCR:{name:'跨频一致性 RMS',unit:'mm',scale:1000,note:'每卫星跨频残差范围 RMS；不是标准差。'},
 ADR:{name:'候选模糊度差异',unit:'cycle',scale:1,note:'原生 ADR；与以 m/mm 表示的残差分开。'},
};

/** Preserve every point and explicit null; insert a break for absent epochs, never bridge a gap. */
export function chartSamples(rows:RealtimeMetrics[],key:string,scale=1,log=false,display?:[number,number]) {
 const steps=rows.slice(1).map((r,i)=>Date.parse(r.time)-Date.parse(rows[i].time)).filter(t=>t>0);
 const interval=median(steps)??1000;const data:(number|null)[][]=[];
 let previous:number|undefined;
 for(const m of rows){
  const t=Date.parse(m.time);if(!Number.isFinite(t))continue;
  if(previous!==undefined&&t-previous>interval*1.5)data.push([previous+Math.min(interval,(t-previous)/2),null,null,0]);
  const raw=numeric(m,key);let value=raw===null?null:raw*scale;
  if(log)value=raw===null||raw<0?null:Math.max(.0001,raw);
  const overflow=value===null||!display?0:value<display[0]?-1:value>display[1]?1:0;
  if(value!==null&&display)value=Math.max(display[0],Math.min(display[1],value));
  data.push([t,value,raw,overflow]);previous=t;
 }
 return data;
}

export function diagnosticCohort(results:ResultSet[],cohort:Cohort):ResultSet[] {
 if(cohort==='own')return results;
 const native=results;
 const sets=native.map(r=>new Set((r.diagnostics??[]).filter(m=>cohort==='common-fixed'?finalFixed(m):true).map(metricKey)));
 const common=new Set(sets.length?[...sets[0]].filter(k=>sets.every(s=>s.has(k))):[]);
 return results.map(r=>({...r,diagnostics:(r.diagnostics??[]).map(m=>{
  const keep=cohort==='fixed'&&finalFixed(m)||(cohort==='common'||cohort==='common-fixed')&&common.has(metricKey(m));
  // Keep the timestamp as a null point so the plot cannot bridge excluded samples.
  return keep?m:{time:m.time,solution:'NONE'};
 })}));
}

export function atmosphereStats(results:ResultSet[],common=false) {
 const ppp=results.filter(r=>solverMode(r)==='PPP');
 return Object.entries(fieldInfo).filter(([key])=>['ZHD','ZWD','TrpSRMS','IonDRMS','ZWDUCor','IAC50','IAC95'].includes(key)).flatMap(([key,info])=>{
  const sets=ppp.map(r=>new Set((r.diagnostics??[]).filter(m=>accepted(m)&&numeric(m,key)!==null).map(metricKey)));
  const shared=new Set(sets.length?[...sets[0]].filter(k=>sets.every(s=>s.has(k))):[]);
  return ppp.map(r=>{const rows=(r.diagnostics??[]).filter(accepted);const values=rows.filter(m=>!common||shared.has(metricKey(m))).flatMap(m=>{const v=numeric(m,key);return v===null?[]:[v*info.scale];});
   return {id:`${r.id}:${key}`,name:r.name,key,field:info.name,unit:info.unit,accepted:rows.length,n:values.length,missing:rows.length-rows.filter(m=>numeric(m,key)!==null).length,
    zero:values.filter(v=>v===0).length,min:values.length?values.reduce((a,b)=>Math.min(a,b)):null,median:quantile(values,.5),p95:quantile(values,.95),max:values.length?values.reduce((a,b)=>Math.max(a,b)):null};
  });
 });
}

export function atmosphereEvents(results:ResultSet[],thresholdMm=20) {
 return results.filter(r=>solverMode(r)==='PPP').flatMap(r=>{
  const rows=r.diagnostics??[];const times=rows.slice(1).map((m,i)=>Date.parse(m.time)-Date.parse(rows[i].time)).filter(v=>v>0);const interval=median(times)??1000;
  const events:{id:string;name:string;start:string;end:string;n:number;peak:number;time:string;metric:RealtimeMetrics}[]=[];
  let last:typeof events[number]|undefined;let previous=0;
  for(const m of rows){const raw=numeric(m,'IonDRMS');const t=Date.parse(m.time);
   if(!accepted(m)||raw===null||raw*1000<thresholdMm){last=undefined;previous=t;continue;}
   if(!last||t-previous>interval*1.5){last={id:`${r.id}:${m.time}`,name:r.name,start:m.time,end:m.time,n:0,peak:-Infinity,time:m.time,metric:m};events.push(last);}
   last.end=m.time;last.n++;if(raw*1000>last.peak){last.peak=raw*1000;last.time=m.time;last.metric=m;}previous=t;
  }
  return events;
 }).sort((a,b)=>b.peak-a.peak);
}

export function atmosphereWindowStats(results:ResultSet[],common=false){
 const width=30*60000,windows=new Set<number>();
 const ppp=results.filter(r=>solverMode(r)==='PPP');
 const buckets=ppp.map(r=>{const bins=new Map<number,RealtimeMetrics[]>();for(const m of r.diagnostics??[]){const t=Date.parse(m.time);if(!Number.isFinite(t))continue;const start=Math.floor(t/width)*width;const bin=bins.get(start);if(bin)bin.push(m);else bins.set(start,[m]);if(accepted(m))windows.add(start);}return bins;});
 return [...windows].sort((a,b)=>a-b).flatMap(start=>atmosphereStats(ppp.map((r,i)=>({...r,diagnostics:buckets[i].get(start)??[]})),common)
  .map(row=>({...row,id:`${row.id}:${start}`,window:new Date(start).toISOString().slice(0,16).replace('T',' ')})));
}

/** Derived display fields keep their source epoch; Q and VQ have independent validity. */
export function geometryDiagnostics(r:ResultSet):ResultSet {
 const positions=new Map(r.epochs.map(e=>[Math.round((e.gpsWeek!==undefined&&e.tow!==undefined?e.gpsWeek*604800+e.tow:Date.parse(e.time)/1000)*1000),e]));
 let baseOrigin:number[]|undefined;
 return {...r,diagnostics:(r.diagnostics??[]).map(m=>{
  const row={...m};const xyz=['X','Y','Z'].map(k=>numeric(m,k));const base=['BaseX','BaseY','BaseZ'].map(k=>numeric(m,k));
  const valid=(a:(number|null)[])=>a.every(v=>v!==null)&&Math.hypot(...a as number[])>1e6;
  row.Baseline=accepted(m)&&valid(xyz)&&valid(base)?Math.hypot(...xyz.map((v,i)=>v!-base[i]!)):null;
  const vector=accepted(m)&&valid(xyz)&&valid(base)?enu(xyz as number[],base as number[]):null;
  row.BaselineE=vector?.[0]??null;row.BaselineN=vector?.[1]??null;row.BaselineU=vector?.[2]??null;
  if(valid(base)){baseOrigin??=base as number[];row.BaseMove=Math.hypot(...base.map((v,i)=>v!-baseOrigin![i]));}else row.BaseMove=null;
  const velocities=['VX','VY','VZ'].map(k=>numeric(m,k));const vq=numeric(m,'VQ');
  row.Speed=vq!==null&&vq>=2&&velocities.every(v=>v!==null)?Math.hypot(...velocities as number[]):null;
  const velocity=row.Speed!==null&&valid(xyz)?enuVelocity(velocities as number[],xyz as number[]):null;
  row.VE=velocity?.[0]??null;row.VN=velocity?.[1]??null;row.VU=velocity?.[2]??null;
  row.Speed2D=velocity?Math.hypot(velocity[0],velocity[1]):null;
  row.Up=positions.get(metricKey(m))?.u??null;
  return row;
 })};
}

export function timeRows(r:ResultSet,window:Window):RealtimeMetrics[]{return(r.diagnostics??[]).filter(m=>{const t=Date.parse(m.time);return(window.start===undefined||t>=window.start)&&(window.end===undefined||t<=window.end);});}
export function diagnosticInterval(r:ResultSet){const keys=(r.diagnostics??[]).map(metricKey);return median(keys.slice(1).map((t,i)=>(t-keys[i])/1000).filter(v=>v>0))??estimateInterval(r.epochs);}

export function stateSegments(rows:RealtimeMetrics[],key:'Q'|'AC'){
 const steps=rows.slice(1).map((m,i)=>Date.parse(m.time)-Date.parse(rows[i].time)).filter(v=>v>0);const interval=median(steps)??1000;
 const segments:{start:number;end:number;value:number;solution:RealtimeMetrics['solution']}[]=[];let previous:number|undefined;let current:typeof segments[number]|undefined;
 for(const m of rows){const raw=numeric(m,key);const at=Date.parse(m.time);if(raw===null||!Number.isFinite(at)){current=undefined;continue;}
  const value=key==='Q'&&raw===8?7:raw;
  if(current&&current.value===value&&previous!==undefined&&at-previous<=interval*1.5){current.end=at;}
  else{current={start:at,end:at,value,solution:m.solution};segments.push(current);}previous=at;
 }
 return segments;
}

export function diagnosticsCsv(results:ResultSet[]){
 const fields=[...new Set(results.flatMap(r=>(r.diagnostics??[]).flatMap(m=>Object.keys(m))))].filter(k=>k!=='time').sort();
 const quote=(v:unknown)=>`"${String(v??'').replaceAll('"','""')}"`;
 return '\uFEFF'+[['方案','模式','UTC',...fields].map(quote).join(','),...results.flatMap(r=>(r.diagnostics??[]).filter(m=>numeric(m,'Q')!==null).map(m=>[r.name,solverMode(r),m.time,...fields.map(k=>m[k])].map(quote).join(',')))].join('\r\n');
}
