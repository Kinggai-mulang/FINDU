import {memo} from 'react';
import {Chart} from './Charts';
import {NoData} from './common';
import {fileColors} from './chart-data';
import {chartSamples} from '../diagnostics';
import {utcAxisLabel} from '../time';
import type {RealtimeMetrics} from '../../contracts';

export function diagnosticValue(raw:unknown,scale=1,logarithmic=false):number|null {
 if(typeof raw!=='number'||!Number.isFinite(raw)||(logarithmic&&raw<0))return null;
 return logarithmic?Math.max(0.0001,raw):raw*scale;
}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Dataset={id:string;name:string;diagnostics?:RealtimeMetrics[];color?:string};
type Props={datasets:Dataset[];fields:string[];label:string;unit?:string;valueScale?:number;logarithmic?:boolean;
 onTimeRange?:(start:number,end:number)=>void;timeDomain?:{start?:number;end?:number};displayBounds?:[number,number];
 labels?:Record<string,string>;states?:Record<number,string>;onInspect?:(time:number)=>void;height?:number};

export const DiagnosticChart=memo(function DiagnosticChart({datasets,fields,label,unit='',valueScale=1,logarithmic=false,onTimeRange,timeDomain,displayBounds,labels={},states,onInspect,height=270}:Props){
 const has=datasets.some(d=>d.diagnostics?.some(m=>fields.some(k=>diagnosticValue(m[k],valueScale,logarithmic)!==null)));
 if(!has)return <NoData text="该日志未提供这些诊断值，保留未知"/>;
 const bounds=logarithmic?[.0001,1] as [number,number]:displayBounds;
 const series=datasets.flatMap((d,i)=>fields.map((k,j)=>{
  const data=chartSamples(d.diagnostics??[],k,valueScale,logarithmic,bounds);
  const color=datasets.length>1?(d.color??fileColors[i%fileColors.length]):fields.length===1?(d.color??fileColors[0]):fileColors[j%fileColors.length];
  return{id:`${d.id}:${k}`,name:datasets.length>1?`${d.name} · ${labels[k]??k}`:labels[k]??k,type:'line' as const,
   symbol:(item:unknown)=>Array.isArray(item)&&item[3]?'triangle':'circle',symbolRotate:(item:unknown)=>Array.isArray(item)&&item[3]===-1?180:0,
   symbolSize:(item:unknown)=>Array.isArray(item)&&item[3]?8:4,showSymbol:!!bounds||data.length<3,connectNulls:false,
   step:states?'end' as const:undefined,encode:{x:0,y:1},lineStyle:{width:1.7,color,type:j%4===3?[8,3,2,3]:(['solid','dashed','dotted'] as const)[j%4]},itemStyle:{color},
   data:data.map(v=>({value:v,symbolSize:v[3]?8:data.length<3?4:0}))};
 }));
 const outside=series.reduce((n,s)=>n+s.data.filter(p=>p.value[3]).length,0);
 return <><Chart label={label} height={height} onTimeRange={onTimeRange} onPoint={onInspect?value=>{if(typeof value[0]==='number')onInspect(value[0]);}:undefined} option={{
  animation:false,color:fileColors,textStyle:{color:'#9eafc8',fontSize:13},legend:{top:8,type:'scroll',textStyle:{color:'#b9c8dc',fontSize:13}},
  tooltip:{trigger:'axis',backgroundColor:'#202c3d',borderColor:'#3d506b',textStyle:{color:'#e5ecf5',fontSize:13},formatter:(params:unknown)=>{
   const rows=(Array.isArray(params)?params:[params]) as {value:(number|null)[];seriesName:string;color:string}[];
   const time=rows[0]?.value?.[0];return(typeof time==='number'?new Date(time).toISOString().replace('T',' ').slice(0,23)+' UTC':'')+rows.map(p=>{
    const raw=p.value?.[2];const value=typeof raw==='number'?raw*(logarithmic?1:valueScale):null;
    const note=p.value?.[3]?'（超出阅读窗，已在边界标记）':'';
    const text=value===null?'—':states?states[value]??String(value):Number(value.toPrecision(6));
    return `<br/><span style="color:${escape(String(p.color))}">●</span> ${escape(p.seriesName)}：${escape(String(text))} ${escape(unit)}${note}`;
   }).join('');}},
  grid:{left:states?84:70,right:38,top:48,bottom:50},xAxis:{type:'time',min:timeDomain?.start,max:timeDomain?.end,
   axisPointer:{show:true,label:{show:false}},axisLabel:{color:'#9cabbe',fontSize:13,hideOverlap:true,formatter:utcAxisLabel}},
  yAxis:{type:logarithmic?'log':'value',logBase:10,min:bounds?.[0],max:bounds?.[1],name:unit,scale:true,interval:states?1:undefined,
   nameTextStyle:{color:'#9cabbe'},axisLabel:{color:'#9cabbe',fontSize:13,hideOverlap:true,formatter:(v:number)=>states?states[v]??'':Number(v.toPrecision(9)).toString()},splitLine:{lineStyle:{color:'#293749',type:'dashed'}}},
  dataZoom:[{id:'time-inside',type:'inside',xAxisIndex:0,filterMode:'none',zoomOnMouseWheel:'shift',moveOnMouseMove:'shift'},
   {id:'time-slider',type:'slider',xAxisIndex:0,height:16,bottom:5,borderColor:'#304158',backgroundColor:'#101926',fillerColor:'#659fff26',handleStyle:{color:'#6685ac',borderColor:'#91abc9'},textStyle:{color:'#91a4bf'}},
   {id:'coordinate-0',type:'inside',yAxisIndex:0,filterMode:'none',zoomOnMouseWheel:true,moveOnMouseMove:true},
   {id:'coordinate-slider-0',type:'slider',yAxisIndex:0,width:10,right:3,showDetail:false,filterMode:'none',borderColor:'#304158',backgroundColor:'#101926',fillerColor:'#659fff26',handleStyle:{color:'#6685ac',borderColor:'#91abc9'}}],series}}/>
  {(bounds||onTimeRange)&&<div className="chart-note diagnostic-chart-note">{logarithmic?'ADOP 对数轴 0.0001–1 cycle；原值保留。':bounds?`阅读窗 ${bounds[0]}–${bounds[1]} ${unit}；越界点 ${outside} 个，三角标记保留原值。`:''}{onTimeRange?' 滚轮调整纵轴 · Shift 调整时间 · 图例筛选':''}</div>}</>;
},(a,b)=>a.datasets===b.datasets&&a.fields.join('|')===b.fields.join('|')&&a.label===b.label&&a.unit===b.unit&&a.valueScale===b.valueScale&&a.logarithmic===b.logarithmic&&a.onTimeRange===b.onTimeRange&&a.onInspect===b.onInspect&&a.height===b.height&&a.timeDomain?.start===b.timeDomain?.start&&a.timeDomain?.end===b.timeDomain?.end&&a.displayBounds?.[0]===b.displayBounds?.[0]&&a.displayBounds?.[1]===b.displayBounds?.[1]&&JSON.stringify(a.states)===JSON.stringify(b.states)&&JSON.stringify(a.labels)===JSON.stringify(b.labels));
