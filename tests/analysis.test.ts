import {describe,it,expect} from 'vitest';
import {buildAnalysis,continuity,convergence,enu,format,sharedResults,summarize,validReference} from '../src/analysis';
import {defaultConfig} from '../src/domain';
import type {Epoch,ResultSet} from '../contracts';
const epoch=(second:number,solution:Epoch['solution']='FLOAT',e=second):Epoch=>({time:new Date(Date.UTC(2026,9,17)+second*1000).toISOString(),gpsWeek:2440,tow:second,e,n:0,u:0,satellites:20,solution});
const result=(id:string,epochs:Epoch[]):ResultSet=>({id,name:id,station:'same',source:'ipspos',config:defaultConfig,epochs,diagnostics:epochs.map(e=>({time:e.time,solution:e.solution,Week:e.gpsWeek!,TOW:e.tow!}))});
const options={window:{},cohort:'common' as const,baselineId:'a',reference:null,motion:'unknown' as const};
describe('analysis contracts',()=>{
 it('uses GPST keys and preserves missing output in the baseline denominator',()=>{const a=result('a',[epoch(0),epoch(1,'FIX'),epoch(2,'HOLD')]),b=result('b',[epoch(0),epoch(2,'FIX')]);b.epochs[1].time=epoch(20).time;const r=buildAnalysis([a,b],options);expect(r.commonCount).toBe(2);expect(r.rows[1].coverage).toBeCloseTo(2/3);expect(r.rows[1].missing).toBe(1);expect(r.rows[0].n).toBe(2);expect(r.rows[1].fixedRate).toBe(.5);});
 it('distinguishes own fixed and common fixed, excludes FLOFIX',()=>{const a=result('a',[epoch(0,'FIX'),epoch(1,'HOLD')]),b=result('b',[epoch(0,'FLOFIX'),epoch(1,'FIX')]);expect(buildAnalysis([a,b],{...options,cohort:'fixed'}).rows.map(r=>r.n)).toEqual([2,1]);expect(buildAnalysis([a,b],{...options,cohort:'common-fixed'}).rows.map(r=>r.n)).toEqual([1,1]);});
 it('shares one ECEF origin instead of zeroing each file independently',()=>{const a=result('a',[{...epoch(0),x:6378137,y:0,z:0}]),b=result('b',[{...epoch(0),x:6378138,y:2,z:3}]);const p=sharedResults([a,b],'a',null);expect([p[1].epochs[0].e,p[1].epochs[0].n,p[1].epochs[0].u]).toEqual([2,3,1]);expect(enu([6378138,2,3],[6378137,0,0])).toEqual([2,3,1]);});
 it('empty samples remain unknown and raw RMS differs from repeatability',()=>{expect(summarize([]).rms).toBeNull();expect(format(null)).toBe('—');expect(summarize([2,2]).std).toBe(0);expect(summarize([2,2]).rms).toBe(2);expect(summarize([0,10]).p95).toBe(9.5);});
 it('never bridges a gap or a SPP/PPP transition for step diagnostics',()=>{const c=continuity([epoch(0,'FIX'),epoch(1,'HOLD'),epoch(5,'FIX'),epoch(6,'SPP'),epoch(7,'FLOAT')],'static',1);expect(c.gaps).toBe(1);expect(c.steps.length).toBe(1);expect(c.segments.map(s=>s.seconds)).toEqual([1,0]);expect(c.switches).toBe(2);});
 it('requires independent reference and sustained continuous thresholds for convergence',()=>{const e=[0,1,2,10,11,12,13].map(t=>epoch(t,'FIX',.01));expect(convergence(e,false,.1,.1,3,1)).toBeNull();expect(convergence(e,true,.1,.1,3,1)).toBe(epoch(10).time);expect(convergence(e,true,undefined,.1,3,1)).toBeNull();});
 it('time windows affect samples, diagnostics and event statistics together',()=>{const a=result('a',[epoch(0),epoch(1),epoch(2)]);const r=buildAnalysis([a],{...options,window:{start:Date.parse(epoch(1).time),end:Date.parse(epoch(1).time)}});expect(r.rows[0].n).toBe(1);expect(r.rows[0].diagnostics.length).toBe(1);expect(r.rows[0].continuity.steps.length).toBe(0);expect(r.universe).toBe(1);});
 it('rejects fake or malformed references',()=>{expect(validReference('0,0,0')).toBeNull();expect(validReference('6378137,NaN,0')).toBeNull();expect(validReference('6378137，0，0')).toEqual([6378137,0,0]);});
});

it('keeps a common valid ENU origin when the selected baseline is still waiting for positioning',()=>{
 const waiting=result('waiting',[]);waiting.referenceXyz=undefined;
 const a=result('a',[{...epoch(1),x:6378137,y:0,z:0}]);a.referenceXyz=[6378137,0,0];
 const b=result('b',[{...epoch(1),x:6378138,y:2,z:3}]);b.referenceXyz=[6378138,2,3];
 const values=sharedResults([waiting,a,b],'waiting',null);
 expect(values[0].epochs).toHaveLength(0);expect(values[2].epochs[0]).toMatchObject({e:2,n:3,u:1});
});
