import {expect,it} from 'vitest';
import type {RealtimeMetrics,RealtimeSnapshot} from '../contracts';
import {realtimeDisplay} from '../src/services/realtime-display';
const now=Date.parse('2026-10-22T00:00:10Z')/1000;
function session(metrics:Partial<RealtimeMetrics>={},changes:Partial<RealtimeSnapshot>={}):RealtimeSnapshot{
 return {state:'running',metrics:{time:'2026-10-22T00:00:05Z',solution:'FLOAT',Obs:33,FloUse:28,CanS:14,CanA:30,SchA:20,FixS:0,FixA:0,AC:2,Ratio:2.58,...metrics},logUpdatedAt:'2026-10-22T00:00:09Z',analysisConfig:{GNSS_ARMode:'2',GNSS_RoveSampleTime:'1'},history:[],...changes} as RealtimeSnapshot;
}
it('shows a current unsuccessful search ratio with explicit AR status and zero fixed satellites',()=>{
 const view=realtimeDisplay(session(),now);expect(view.metrics?.Ratio).toBe(2.58);expect(view.metrics?.FixS).toBe(0);expect(view.arLabel).toBe('AR 未通过');
 expect(realtimeDisplay(session({AC:3,Ratio:30.033}),now).arLabel).toBe('AR 确认中');
});
it.each(['Obs','FloUse','CanS','CanA','SchA'])('does not present a ratio with zero %s even if the source contains an old number',key=>{
 expect(realtimeDisplay(session({[key]:0}),now).metrics?.Ratio).toBeNull();
});
it('does not present an AR ratio when AR is disabled or the solution is SPP',()=>{
 expect(realtimeDisplay(session({}, {analysisConfig:{GNSS_ARMode:'0'}}),now).metrics?.Ratio).toBeNull();
 expect(realtimeDisplay(session({solution:'SPP'}),now).metrics?.Ratio).toBeNull();
});
it('expires current counters on receipt timeout while retaining raw metrics and history',()=>{
 const live=session({}, {logUpdatedAt:'2026-10-21T23:59:59Z'});const original=structuredClone(live);
 const view=realtimeDisplay(live,now);expect(view.stale).toBe(true);expect(view.solution).toBe('历元停更');expect(view.metrics).toBeUndefined();expect(live).toEqual(original);
 expect(realtimeDisplay({...live,logUpdatedAt:'2026-10-22T00:00:10Z'},now).metrics?.Ratio).toBe(2.58);
});
it('does not infer a slow cadence from just one gap at startup',()=>{
 const live=session({}, {history:[{time:'2026-10-21T23:50:00Z',solution:'FLOAT'},{time:'2026-10-22T00:00:00Z',solution:'FLOAT'}]});
 expect(realtimeDisplay(live,now).timeoutSeconds).toBe(10);
 expect(realtimeDisplay({...live,logUpdatedAt:'2026-10-22T00:00:04Z'},now).stale).toBe(false);
});
it('uses observed five-second cadence instead of falsely applying the configured one-second interval',()=>{
 const live=session({}, {logUpdatedAt:'2026-10-22T00:00:00Z',history:[0,5,10,15].map(t=>({time:`2026-10-22T00:00:${String(t).padStart(2,'0')}Z`,solution:'FLOAT'}))});
 expect(realtimeDisplay(live,now).timeoutSeconds).toBe(15);expect(realtimeDisplay(live,now).stale).toBe(false);expect(realtimeDisplay(live,now+6).stale).toBe(true);
 const overview={...live,history:[],epochIntervalSeconds:5};
 expect(realtimeDisplay(overview,now).timeoutSeconds).toBe(15);expect(realtimeDisplay(overview,now).stale).toBe(false);
});
it('uses receipt time for historical replay and labels stopped metrics as the last epoch',()=>{
 expect(realtimeDisplay(session({time:'2024-03-06T00:00:00Z'}),now).stale).toBe(false);
 const stopped=realtimeDisplay(session({}, {state:'stopped',logUpdatedAt:'2020-01-01T00:00:00Z'}),now);
 expect(stopped.solutionLabel).toBe('末历元解状态');expect(stopped.metrics?.Ratio).toBe(2.58);
});
it('does not trust metrics with missing receipt timestamps or a current parser error',()=>{
 expect(realtimeDisplay(session({}, {logUpdatedAt:null}),now).stale).toBe(true);
 expect(realtimeDisplay(session({}, {parseError:'bad row'}),now).stale).toBe(true);
 expect(realtimeDisplay(undefined,now).solution).toBe('—');
});
it('expires live transfer rates if heartbeat output freezes and zeroes them after stop',()=>{
 const live=session({}, {heartbeat:{arrivalUnix:now-1} as RealtimeSnapshot['heartbeat']});
 expect(realtimeDisplay(live,now).statusFresh).toBe(true);
 expect(realtimeDisplay(live,now+5).statusFresh).toBe(false);
 expect(realtimeDisplay({...live,state:'stopped'},now).statusFresh).toBe(false);
});
