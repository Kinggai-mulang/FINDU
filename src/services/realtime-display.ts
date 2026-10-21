import type {RealtimeMetrics, RealtimeSnapshot} from '../../contracts';

const arStates:Record<number,string>={0:'未进入',1:'条件不足',2:'未通过',3:'确认中',4:'成功'};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);

/** Wall-clock receipt time determines freshness; GNSS time may belong to a replay. */
export function realtimeDisplay(live:RealtimeSnapshot|undefined,nowSeconds:number){
  const active=!!live&&['starting','running','stopping'].includes(live.state);
  const last=live?.metrics??undefined;
  const configured=Number(live?.analysisConfig?.GNSS_RoveSampleTime);
  const history=live?.history.slice(-21)??[];
  const steps=history.slice(1).map((m,i)=>(Date.parse(m.time)-Date.parse(history[i].time))/1000).filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);
  const observed=live?.epochIntervalSeconds;
  const cadence=Math.max(Number.isFinite(configured)&&configured>0?configured:1,finite(observed)&&observed>0?observed:steps.length>=2?steps[Math.floor((steps.length-1)/2)]:1);
  const timeoutSeconds=Math.max(10,cadence*3);
  const updated=Date.parse(live?.logUpdatedAt??'')/1000;
  const ageSeconds=Number.isFinite(updated)?Math.max(0,nowSeconds-updated):undefined;
  const stale=active&&!!last&&(!!live?.parseError||ageSeconds===undefined||ageSeconds>timeoutSeconds);
  const metrics=stale?undefined:last;
  const arOff=live?.analysisConfig?.GNSS_ARMode==='0';
  const impossibleSearch=last&&(['Obs','FloUse','CanS','CanA','SchA'].some(k=>finite(last[k])&&last[k]<=0)||!['FLOAT','FLOFIX','FIX','HOLD'].includes(last.solution));
  const ratio=metrics&&!arOff&&!impossibleSearch&&finite(metrics.Ratio)&&metrics.Ratio>0?metrics.Ratio:undefined;
  const displayMetrics:RealtimeMetrics|undefined=metrics?{...metrics,Ratio:ratio??null}:undefined;
  const arState=arOff?'AR 关闭':last&&finite(last.AC)?`AR ${arStates[last.AC]??'状态未知'}`:'AR 未提供';
  const arrival=live?.heartbeat?.arrivalUnix;
  const statusFresh=active&&finite(arrival)&&nowSeconds-arrival<=5;
  return {active,stale,ageSeconds,timeoutSeconds,statusFresh,metrics:displayMetrics,
    solutionLabel:!active&&last?'末历元解状态':'当前解状态',
    solution:stale?'历元停更':metrics?.solution??'—',
    arLabel:stale?'等待新历元':arState,
    epochDetail:stale?`${ageSeconds===undefined?'':Math.floor(ageSeconds)+' 秒未更新 · '}最近 ${last?.time??'—'}`:last?.time?`${last.time} UTC`:'等待首个观测历元'};
}
