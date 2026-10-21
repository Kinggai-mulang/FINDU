import { memo, useEffect, useRef, useState } from 'react';
import { Button, InputNumber, Segmented, Space } from 'antd';
import * as echarts from 'echarts/core';
import { LineChart, BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, MarkPointComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import type { Epoch, ResultSet } from '../../contracts';
import { coloredData, equalExtent, fileColors, directionColors, solutionGroups, solutionColor } from './chart-data';
import { epochXyz, projectEpochs, positionTooltip, type Xyz } from './positioning-data';
import {utcAxisLabel} from '../time';

echarts.use([LineChart,BarChart,GridComponent,TooltipComponent,LegendComponent,DataZoomComponent,MarkPointComponent,CanvasRenderer]);
export const Chart=memo(function Chart({option,label,height=280,onTimeRange,onPoint,coordinateKey}:{option:EChartsCoreOption;label:string;height?:number;onTimeRange?:(start:number,end:number)=>void;onPoint?:(value:unknown[])=>void;coordinateKey?:string}) {
  const el=useRef<HTMLDivElement>(null);
  const instance=useRef<echarts.EChartsType|undefined>(undefined);
  const [visible,setVisible]=useState(false);
  const visibility=useRef(false);visibility.current=visible;
  const limits=useRef<string|undefined>(undefined);
  const previousWidth=useRef(0);
  const inspected=useRef(new Set<string>());
  const previousCoordinates=useRef(coordinateKey);
  const pointCallback=useRef(onPoint);pointCallback.current=onPoint;
  const callback=useRef(onTimeRange);callback.current=onTimeRange;const applying=useRef(false);
  useEffect(()=>{
    if(!el.current)return;
    instance.current=echarts.init(el.current,undefined,{renderer:'canvas'});
    instance.current.on('click',params=>{const value=(params as unknown as {value?:unknown[]}).value;if(Array.isArray(value))pointCallback.current?.(value);});
    // Sparse visible symbols keep dash patterns legible; hit testing still uses every epoch.
    instance.current.getZr().on('click',event=>{
      const chart=instance.current;if(!chart||!pointCallback.current)return;
      let best:unknown[]|undefined;let distance=81;
      const current=chart.getOption();const legends=(current.legend??[]) as {selected?:Record<string,boolean>}[];
      const all=(current.series??[]) as ({name?:string;data?:unknown[]}|null)[];
      all.forEach((series,seriesIndex)=>{
        if(!series)return;
        if(legends.some(l=>series.name&&l.selected?.[series.name]===false))return;
        if(!chart.containPixel({seriesIndex},[event.offsetX,event.offsetY]))return;
        for(const item of series.data??[]){
          const value=Array.isArray(item)?item:(item as {value?:unknown[]})?.value;
          if(!value||typeof value[0]!=='number'||typeof value[1]!=='number'||!Number.isFinite(value[0])||!Number.isFinite(value[1]))continue;
          const pixel=chart.convertToPixel({seriesIndex},value.slice(0,2)) as number[];
          const d=(pixel[0]-event.offsetX)**2+(pixel[1]-event.offsetY)**2;
          if(d<distance){distance=d;best=value;}
        }
      });
      if(best)pointCallback.current(best);
    });
    let timer:ReturnType<typeof setTimeout>|undefined;
    instance.current.on('datazoom',(event:unknown)=>{
      if(applying.current)return;
      const change=event as {dataZoomId?:string;batch?:{dataZoomId?:string}[]};
      const ids=(change.batch??[change]).flatMap(v=>v.dataZoomId?[v.dataZoomId]:[]);
      for(const id of ids)inspected.current.add(id==='time-slider'?'time-inside':id.replace('coordinate-slider-','coordinate-'));
      // A Y-only inspection must not freeze the shared live time window.
      if(!callback.current||!ids.some(id=>id==='time-inside'||id==='time-slider'))return;
      clearTimeout(timer);timer=setTimeout(()=>{const zooms=(instance.current?.getOption().dataZoom??[]) as {id?:string;startValue?:number;endValue?:number}[];const z=zooms.find(z=>z.id==='time-inside');if(typeof z?.startValue==='number'&&typeof z?.endValue==='number')callback.current?.(z.startValue,z.endValue);},180);
    });
    const observer=new ResizeObserver(()=>{if(visibility.current)instance.current?.resize();});observer.observe(el.current);
    const intersection=new IntersectionObserver(entries=>setVisible(entries[0].isIntersecting),{rootMargin:'180px'});intersection.observe(el.current);
    return ()=>{clearTimeout(timer);observer.disconnect();intersection.disconnect();instance.current?.dispose();instance.current=undefined;};
  },[]);
  useEffect(()=>{
    const node=el.current,chart=instance.current;
    if(!visible||!node?.clientWidth||!node.clientHeight||!chart)return;
    if(Math.abs(chart.getWidth()-node.clientWidth)>1||Math.abs(chart.getHeight()-node.clientHeight)>1)chart.resize();
    const ys=(Array.isArray(option.yAxis)?option.yAxis:[option.yAxis]) as {min?:number;max?:number}[];
    const next=JSON.stringify(ys.map(y=>[y?.min,y?.max]));
    const originChanged=previousCoordinates.current!==coordinateKey;
    const boundsChanged=originChanged||(limits.current!==undefined&&limits.current!==next);
    const zooms=(instance.current?.getOption()?.dataZoom??[]) as {id:string;start:number;end:number;startValue?:number;endValue?:number}[];
    // Lock inspected intervals to absolute values while new live samples extend the data domain.
    const width=instance.current?.getWidth()??0;
    const locked=zooms.filter(z=>inspected.current.has(z.id)&&(z.id==='time-inside'||(!boundsChanged&&/^coordinate-\d$/.test(z.id))||(!originChanged&&previousWidth.current===width&&/^en-[xy]$/.test(z.id)))&&(z.start>0||z.end<100)&&z.startValue!==undefined&&z.endValue!==undefined);
    applying.current=true;
    instance.current?.setOption({...option,useUTC:true},{replaceMerge:['series'],lazyUpdate:true,silent:true});
    if(!inspected.current.has('time-inside')&&(Array.isArray(option.dataZoom)?option.dataZoom:[]).some(z=>(z as {id?:string}).id==='time-inside'))instance.current?.dispatchAction({type:'dataZoom',dataZoomId:'time-inside',start:0,end:100},{silent:true});
    locked.forEach(z=>instance.current?.dispatchAction({type:'dataZoom',dataZoomId:z.id,startValue:z.startValue,endValue:z.endValue},{silent:true}));
    if(boundsChanged)ys.forEach((_,i)=>instance.current?.dispatchAction({type:'dataZoom',dataZoomId:`coordinate-${i}`,start:0,end:100},{silent:true}));
    if(originChanged)for(const id of ['en-x','en-y'])if(zooms.some(z=>z.id===id))instance.current?.dispatchAction({type:'dataZoom',dataZoomId:id,start:0,end:100},{silent:true});
    previousCoordinates.current=coordinateKey;
    limits.current=next;
    previousWidth.current=width;
    applying.current=false;
  },[option,coordinateKey,visible]);
  return <div ref={el} role="img" aria-label={label} style={{height,width:'100%'}}/>;
});
function base():EChartsCoreOption {
  return {
    animation:false,backgroundColor:'transparent',color:fileColors,
    textStyle:{color:'#93a4bb',fontFamily:'Segoe UI, Microsoft YaHei, sans-serif',fontSize:12},
    tooltip:{trigger:'axis',backgroundColor:'#202c3d',borderColor:'#3d506b',textStyle:{color:'#e5ecf5',fontSize:13},valueFormatter:(v:unknown)=>typeof v==='number'?v.toFixed(4):String(v)},
    legend:{top:8,right:32,textStyle:{color:'#b0bfd3',fontSize:12},icon:'roundRect',itemWidth:15,itemHeight:4},
    grid:{left:68,right:44,top:48,bottom:54},
    xAxis:timeAxis(0),yAxis:valueAxis('m',0),
    dataZoom:[{id:'time-inside',type:'inside',xAxisIndex:0,filterMode:'none',zoomOnMouseWheel:true,moveOnMouseMove:true},{id:'time-slider',type:'slider',xAxisIndex:0,height:18,bottom:6,borderColor:'#30405a',fillerColor:'#669fff24',textStyle:{color:'#91a4bf'}}],
  };
}
const timeAxis=(gridIndex:number)=>({type:'time',gridIndex,axisLine:{lineStyle:{color:'#354157'}},axisLabel:{hideOverlap:true,formatter:utcAxisLabel},splitLine:{show:false}});
const valueAxis=(name:string,gridIndex:number)=>({type:'value',gridIndex,name,scale:true,nameTextStyle:{color:'#9cabbe'},splitLine:{lineStyle:{color:'#2a3547',type:'dashed'}},axisLabel:{color:'#91a2b9',hideOverlap:true,formatter:(value:number)=>Number(value.toPrecision(5)).toString()}});
type View='stacked'|'overlay'|'trajectory';
type Dataset={id:string;name:string;epochs:Epoch[];referenceXyz?:number[];runId?:string};
const axes=['e','n','u'] as const;

/** A common view for live, post-process preview and result analysis. */
function PositioningChartView({datasets:inputs,height=440,onTimeRange,timeDomain,coordinateExtent:defaultExtent,allowOriginSelection=true}:{datasets:Dataset[];height?:number;onTimeRange?:(start:number,end:number)=>void;timeDomain?:{start?:number;end?:number};coordinateExtent?:number[][];allowOriginSelection?:boolean}) {
  const [view,setView]=useState<View>('stacked');const [revision,setRevision]=useState(0);
  const [colorBy,setColorBy]=useState<'direction'|'solution'>('direction');
  const [direction,setDirection]=useState<'all'|'e'|'n'|'u'>('all');
  const identity=inputs.map(d=>`${d.id}:${d.runId??''}`).join('|');
  const [originState,setOrigin]=useState<{identity:string;xyz:Xyz;time:string}|null>(null);
  const [selection,setSelection]=useState<{identity:string;xyz:Xyz;time:string;name:string}|null>(null);
  const origin=originState?.identity===identity?originState:null;
  const selected=selection?.identity===identity?selection:null;
  const datasets=inputs.map(d=>({...d,epochs:projectEpochs(d.epochs,origin?.xyz??null)}));
  const coordinateExtent=origin?undefined:defaultExtent;
  const defaultOrigin=inputs[0]?.referenceXyz;
  const pickable=allowOriginSelection&&inputs.some(d=>d.epochs.some(e=>epochXyz(e)));
  const pickPoint=(value:unknown[])=>{
    if(!pickable)return;
    const data=inputs.find(d=>d.id===value[6]);const e=data?.epochs.find(e=>e.time===value[3]);const xyz=e&&epochXyz(e);
    if(xyz&&data)setSelection({identity,xyz,time:e!.time,name:data.name});
  };
  const [bounds,setBounds]=useState<Partial<Record<'e'|'n'|'u', [number|null,number|null]>>>({});
  const [size,setSize]=useState(800);const wrapper=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!wrapper.current)return;const o=new ResizeObserver(e=>setSize(e[0].contentRect.width));o.observe(wrapper.current);return()=>o.disconnect();},[]);
  const option=base();const compare=datasets.length>1;const stacked=view==='stacked';const byDirection=view==='overlay'&&!compare&&colorBy==='direction';
  const series:unknown[]=[];
  const add=(data:Dataset,di:number,key:'e'|'n'|'u',ai:number)=>{
    if(view==='overlay'&&direction!=='all'&&direction!==key)return;
    const index=stacked?ai:0;
    const values=(e:Epoch)=>view==='trajectory'?[e.e,e.n]:[Date.parse(e.time),e[key]];
    const metadata=(value:unknown[])=>[...value,view==='trajectory'?'EN':key.toUpperCase(),data.name,data.id];
    const overlay=view==='overlay';const stride=Math.max(1,Math.ceil(data.epochs.length/Math.max(8,Math.floor(size/44))));
    const shape={type:'line',xAxisIndex:index,yAxisIndex:index,symbol:overlay?(['circle','diamond','triangle'] as const)[ai]:'circle',symbolSize:overlay?(_v:unknown,p:{dataIndex:number})=>p.dataIndex%stride===0||p.dataIndex===data.epochs.length-1?6:0:5,showSymbol:true,connectNulls:false,animation:false,emphasis:{focus:'series'},lineStyle:{width:overlay?1.8:1.4,type:overlay?(['solid',[12,6],[2,5]] as const)[ai]:'solid'},encode:{x:0,y:1},dimensions:['x','y','原始解状态','UTC','方向','方案','方案ID']};
    if(compare)series.push({...shape,id:`${data.id}:${key}`,name:data.name,itemStyle:{color:fileColors[di%fileColors.length]},data:data.epochs.map(e=>metadata([...values(e),e.solution,e.time]))});
    else if(byDirection)series.push({...shape,id:`${data.id}:${key}:direction`,name:key.toUpperCase(),lineStyle:{...shape.lineStyle,color:directionColors[key]},itemStyle:{color:directionColors[key]},data:data.epochs.map(e=>metadata([...values(e),e.solution,e.time]))});
    else for(const group of solutionGroups){if(!data.epochs.some(e=>(group.states as readonly string[]).includes(e.solution)))continue;series.push({...shape,id:`${data.id}:${key}:${group.name}`,name:group.name,lineStyle:{...shape.lineStyle,color:group.color},itemStyle:{color:group.color},data:coloredData(data.epochs,group.states,values).map(value=>({value:metadata(value),itemStyle:{color:solutionColor(value[2] as Epoch['solution'])}}))});}
  };
  if(view==='trajectory'){
    const extent=equalExtent(datasets.flatMap(d=>d.epochs),Math.max(size-112,100),height-102);
    option.xAxis={...valueAxis('E / m',0),min:extent.minX,max:extent.maxX};option.yAxis={...valueAxis('N / m',0),min:extent.minY,max:extent.maxY};
    option.tooltip={trigger:'item',backgroundColor:'#202c3d',borderColor:'#3d506b',textStyle:{color:'#e5ecf5'},formatter:(p:unknown)=>positionTooltip(p,true)};
    // Both controllers share the grid: a wheel applies the same factor, while drag uses each axis.
    option.dataZoom=[{id:'en-x',type:'inside',xAxisIndex:0,filterMode:'none'},{id:'en-y',type:'inside',yAxisIndex:0,filterMode:'none'}];
    datasets.forEach((d,i)=>add(d,i,'e',0));
    datasets.forEach(d=>{
      const points=d.epochs.filter(e=>Number.isFinite(e.e)&&Number.isFinite(e.n));if(!points.length)return;
      const name=compare?d.name:solutionGroups.find(g=>(g.states as readonly string[]).includes(points[points.length-1].solution))?.name;
      series.push({id:`${d.id}:endpoints`,type:'line',name,data:[],showSymbol:false,z:50,markPoint:{symbol:'triangle',symbolSize:8,z:100,label:{show:false},data:[{name:'起点',coord:[points[0].e,points[0].n],value:[points[0].e,points[0].n,points[0].solution,points[0].time,'EN',d.name,d.id],itemStyle:{color:'#05603a',borderColor:'#34ff83',borderWidth:1.5}},{name:'当前终点',coord:[points[points.length-1].e,points[points.length-1].n],symbolRotate:180,value:[points[points.length-1].e,points[points.length-1].n,points[points.length-1].solution,points[points.length-1].time,'EN',d.name,d.id],itemStyle:{color:'#960c26',borderColor:'#ff5265',borderWidth:1.5}}]}});
    });
  }else{
    option.tooltip={...(option.tooltip as object),formatter:(p:unknown)=>positionTooltip(p,false)};
    const count=stacked?3:1;const pane=(height-104-(count-1)*32)/count;
    option.grid=Array.from({length:count},(_,i)=>({left:68,right:44,top:48+i*(pane+32),height:pane}));
    option.xAxis=Array.from({length:count},(_,i)=>({...timeAxis(i),min:timeDomain?.start,max:timeDomain?.end,axisLabel:{...(timeAxis(i).axisLabel),show:i===count-1}}));
    option.yAxis=Array.from({length:count},(_,i)=>({...valueAxis(stacked?`${axes[i].toUpperCase()} / m`:'ENU / m',i),min:bounds[axes[i]]?.[0]??(stacked?coordinateExtent?.[i]?.[0]:coordinateExtent?Math.min(...coordinateExtent.map(e=>e[0])):undefined),max:bounds[axes[i]]?.[1]??(stacked?coordinateExtent?.[i]?.[1]:coordinateExtent?Math.max(...coordinateExtent.map(e=>e[1])):undefined)}));
    option.axisPointer={link:[{xAxisIndex:'all'}]};
    option.dataZoom=[{id:'time-inside',type:'inside',xAxisIndex:Array.from({length:count},(_,i)=>i),filterMode:'none',zoomOnMouseWheel:'shift',moveOnMouseMove:'shift'},{id:'time-slider',type:'slider',xAxisIndex:Array.from({length:count},(_,i)=>i),height:18,bottom:6},...Array.from({length:count},(_,i)=>({id:`coordinate-${i}`,type:'inside',yAxisIndex:i,filterMode:'none',zoomOnMouseWheel:true,moveOnMouseMove:true})),...Array.from({length:count},(_,i)=>({id:`coordinate-slider-${i}`,type:'slider',yAxisIndex:i,orient:'vertical',right:8,top:48+i*(pane+32),height:pane,width:12,showDetail:false}))];
    datasets.forEach((d,i)=>axes.forEach((k,a)=>add(d,i,k,a)));
  }
  option.series=series;
  return <div ref={wrapper} className="positioning-chart"><div className="chart-toolbar"><Segmented aria-label="坐标图布局" value={view} onChange={v=>setView(v as View)} options={[{value:'stacked',label:'E / N / U 三行'},{value:'overlay',label:'ENU 叠加'},{value:'trajectory',label:'EN 轨迹'}]}/><Button onClick={()=>{setBounds({});setRevision(r=>r+1);}}>重置视图</Button></div>
    {view==='overlay'&&<div className="overlay-controls"><Space wrap>{!compare&&<><span>着色</span><Segmented aria-label="叠加图着色" value={colorBy} onChange={v=>setColorBy(v as 'direction'|'solution')} options={[{value:'direction',label:'按方向'},{value:'solution',label:'按解状态'}]}/></>}<span>方向</span><Segmented aria-label="叠加方向" value={direction} onChange={v=>setDirection(v as typeof direction)} options={[{value:'all',label:'全部'},{value:'e',label:'E'},{value:'n',label:'N'},{value:'u',label:'U'}]}/></Space></div>}
    {allowOriginSelection&&<div className="origin-controls"><div><b>ENU 显示原点</b><span>{(origin?.xyz??defaultOrigin)?.map(v=>v.toFixed(3)).join(', ')??'沿用结果坐标'}{(origin?.xyz??defaultOrigin)?' m':''}</span><small>{origin?`选定点 · ${origin.time} UTC`:'默认原点'}</small></div><Space wrap><Button size="small" disabled={!selected} onClick={()=>{if(selected){setOrigin({identity,xyz:selected.xyz,time:selected.time});setBounds({});}}}>将选中点设为原点</Button><Button size="small" disabled={!origin} onClick={()=>{setOrigin(null);setBounds({});}}>恢复默认原点</Button></Space><p>{selected?`已选：${selected.name} · ${selected.time} UTC · XYZ ${selected.xyz.map(v=>v.toFixed(3)).join(', ')} m`:pickable?'点击曲线上的定位点，然后设为原点。':'当前数据未提供有效 XYZ，无法选点重算原点。'} 仅改变显示坐标，参考统计与导出保持原口径。{origin&&inputs.some(d=>d.epochs.some(e=>!epochXyz(e)))?'缺少 XYZ 的历元不在重投影曲线中显示。':''}</p></div>}
    {view==='overlay'&&<div className="axis-key" aria-label="ENU 方向线型"><span style={{color:byDirection?directionColors.e:undefined}}><i/>E · 东 · 实线圆点</span><span style={{color:byDirection?directionColors.n:undefined}}><i/>N · 北 · 长虚线菱形</span><span style={{color:byDirection?directionColors.u:undefined}}><i/>U · 天 · 点线三角</span></div>}
    {view==='trajectory'&&<div className="trajectory-key" aria-label="轨迹起终点图例"><span><i/>起点</span><span><i/>当前终点</span></div>}
    {view!=='trajectory'&&<div className="coordinate-controls"><span>坐标范围 / m</span>{(stacked?axes:['e'] as const).map(k=><Space key={k} size={6}><b>{stacked?k.toUpperCase():'ENU'}</b><InputNumber aria-label={`${k} 最小值`} placeholder="自动" size="small" value={bounds[k]?.[0]} onChange={v=>setBounds(b=>({...b,[k]:[v,b[k]?.[1]??null]}))}/><span>至</span><InputNumber aria-label={`${k} 最大值`} placeholder="自动" size="small" value={bounds[k]?.[1]} onChange={v=>setBounds(b=>({...b,[k]:[b[k]?.[0]??null,v]}))}/></Space>)}</div>}
    <Chart key={`${view}-${revision}-${identity}`} option={option} height={height} onTimeRange={view==='trajectory'?undefined:onTimeRange} onPoint={pickPoint} coordinateKey={origin?.xyz.join(',')??'default'} label={view==='trajectory'?'EN 等比例轨迹，单位米':'ENU 三方向曲线，时间 UTC，单位米'}/>
    <div className="chart-note">{view==='trajectory'?'E、N 等比例 · 滚轮缩放与拖动同步作用于两轴 · 起终点按当前数据窗口更新':`滚轮 / 拖动：坐标缩放与平移 · Shift + 滚轮 / 拖动：时间 · 底部滑块：固定时段${view==='overlay'?' · E 实线圆点 / N 长虚线菱形 / U 点线三角':''}`} · {compare?'每个文件一种颜色':byDirection?'E / N / U 按方向着色；提示中保留原始解状态':'按解类型着色 · FIX / HOLD 均为固定解'} · 点击图例筛选</div>
  </div>;
}
export const PositioningChart=memo(PositioningChartView,(a,b)=>a.height===b.height&&a.allowOriginSelection===b.allowOriginSelection&&a.onTimeRange===b.onTimeRange&&a.timeDomain?.start===b.timeDomain?.start&&a.timeDomain?.end===b.timeDomain?.end&&a.coordinateExtent===b.coordinateExtent&&a.datasets.length===b.datasets.length&&a.datasets.every((d,i)=>{const other=b.datasets[i];return d.id===other.id&&d.name===other.name&&d.runId===other.runId&&d.epochs===other.epochs&&d.referenceXyz===other.referenceXyz;}));
export function EnuChart({epochs,height=440,referenceXyz,runId,timeDomain,onTimeRange}:{epochs:Epoch[];height?:number;referenceXyz?:number[]|null;runId?:string;timeDomain?:{start?:number;end?:number};onTimeRange?:(start:number,end:number)=>void}) {return <PositioningChart timeDomain={timeDomain} onTimeRange={onTimeRange} datasets={[{id:'single',name:'当前解',epochs,referenceXyz:referenceXyz??undefined,runId}]} height={Math.max(height,400)}/>;}
export function CompareChart({results,onTimeRange,timeDomain,coordinateExtent,allowOriginSelection}:{results:ResultSet[];axis?:'e'|'n'|'u';onTimeRange?:(start:number,end:number)=>void;timeDomain?:{start?:number;end?:number};coordinateExtent?:number[][];allowOriginSelection?:boolean}) {return <PositioningChart datasets={results} onTimeRange={onTimeRange} timeDomain={timeDomain} coordinateExtent={coordinateExtent} allowOriginSelection={allowOriginSelection}/>;}
export function SatelliteChart({epochs}:{epochs:Epoch[]}) {
  const option=base();option.yAxis={...valueAxis('颗',0),min:0};option.dataZoom=[];option.grid={left:45,right:18,top:36,bottom:28};
  option.series=[{name:'参与解算卫星',type:'line',step:'end',showSymbol:false,lineStyle:{width:1.6,color:'#58d8af'},areaStyle:{color:'#58d8af15'},data:epochs.map(e=>[Date.parse(e.time),e.satellites])}];
  return <Chart option={option} label="参与解算卫星数量" height={180}/>;
}
