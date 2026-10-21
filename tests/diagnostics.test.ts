import {describe,it,expect} from 'vitest';
import type {RealtimeMetrics,ResultSet} from '../contracts';
import {defaultConfig} from '../src/domain';
import {buildAnalysis} from '../src/analysis';
import {atmosphereStats,atmosphereWindowStats,atmosphereEvents,chartSamples,diagnosticCohort,geometryDiagnostics,stateSegments,diagnosticsCsv,solverMode} from '../src/diagnostics';
const row=(second:number,extra:Partial<RealtimeMetrics>={}):RealtimeMetrics=>({time:new Date(Date.UTC(2026,9,21)+second*1000).toISOString(),Week:2441,TOW:second,solution:'FLOAT',Q:5,...extra});
const result=(id:string,rows:RealtimeMetrics[],mode:'PPP'|'RTK'='PPP'):ResultSet=>({id,name:id,source:'ipspos',station:'station',solutionMode:mode,config:{...defaultConfig,mode},epochs:[],diagnostics:rows});

describe('mode-aware native diagnostics',()=>{
 it('uses native mode and never guesses real mode from a default PPP configuration',()=>{
  const r=result('rtk',[],'RTK');expect(solverMode(r)).toBe('RTK');r.solutionMode=undefined;expect(solverMode(r)).toBe('UNKNOWN');
 });
 it('preserves negative wet delay, signed correlation, zero and field-specific valid denominators',()=>{
  const r=result('a',[row(0,{ZWD:-.001,ZWDUCor:-1,IonDRMS:0}),row(1,{ZWD:.003,ZWDUCor:null,IonDRMS:null}),row(2,{Q:0,solution:'NONE',ZWD:.9})]);
  const stats=atmosphereStats([r]);expect(stats.find(s=>s.key==='ZWD')).toMatchObject({n:2,accepted:2,min:-1,median:1,max:3});
  expect(stats.find(s=>s.key==='ZWDUCor')).toMatchObject({n:1,missing:1,min:-1});expect(stats.find(s=>s.key==='IonDRMS')).toMatchObject({n:1,zero:1});
  expect(r.diagnostics![0].ZWD).toBe(-.001);
 });
 it('computes each common field cohort with exact GPST keys, independent of UTC display',()=>{
  const a=result('a',[row(0,{ZWD:.1}),row(1,{ZWD:.2})]);const b=result('b',[row(30,{TOW:0,ZWD:.3}),row(1,{ZWD:null})]);
  expect(atmosphereStats([a,b],true).filter(r=>r.key==='ZWD').map(r=>[r.n,r.median])).toEqual([[1,100],[1,300]]);
  expect(diagnosticCohort([a,b],'common')[0].diagnostics?.[0].Q).toBe(5);
 });
 it('breaks missing and excluded samples without turning them into zero or accepted atmosphere rows',()=>{
  const r=result('a',[row(0,{IonDRMS:.01}),row(1,{solution:'FIX',Q:7,IonDRMS:0})]);const selected=diagnosticCohort([r],'fixed');
  expect(atmosphereStats(selected).find(r=>r.key==='IonDRMS')).toMatchObject({accepted:1,n:1,zero:1});
  expect(chartSamples(selected[0].diagnostics!,'IonDRMS',1000).map(r=>r[1])).toEqual([null,0]);
 });
 it('keeps full spike values while marking display clipping and gaps',()=>{
  const data=chartSamples([row(0,{IonDRMS:.001}),row(1,{IonDRMS:2}),row(2,{IonDRMS:0}),row(10,{IonDRMS:.003}),row(11,{IonDRMS:.004})],'IonDRMS',1000,false,[0,20]);
  expect(data[1].slice(1)).toEqual([20,2,1]);expect(data.some(d=>d[1]===null)).toBe(true);expect(data[2][1]).toBe(0);
 });
 it('groups QC evidence into separate continuous event windows instead of silently dropping spikes',()=>{
  const r=result('a',[row(0,{IonDRMS:.03}),row(1,{IonDRMS:.04,FltR:1}),row(2,{IonDRMS:0}),row(10,{IonDRMS:.1}),row(11,{IonDRMS:0})]);
  const events=atmosphereEvents([r]);expect(events).toHaveLength(2);expect(events[0].peak).toBe(100);expect(events[1]).toMatchObject({n:2,peak:40});expect(events[1].metric.FltR).toBe(1);
 });
 it('compacts state strips while preserving gaps and sharing FIX/HOLD presentation',()=>{
  const segments=stateSegments([row(0,{Q:7,solution:'FIX'}),row(1,{Q:8,solution:'HOLD'}),row(2,{Q:7,solution:'FIX'}),row(10,{Q:7,solution:'FIX'}),row(11,{Q:7,solution:'FIX'})],'Q');
  expect(segments).toHaveLength(2);expect(segments[0]).toMatchObject({start:Date.parse(row(0).time),end:Date.parse(row(2).time),value:7});
 });
 it('derives RTK geometry only with valid paired coordinates, and gates velocity independently of Q',()=>{
  const r=result('r',[row(0,{X:6378137,Y:2,Z:3,BaseX:6378137,BaseY:0,BaseZ:0,VQ:0,VX:1,VY:2,VZ:2}),row(1,{Q:0,solution:'NONE',X:null,BaseX:6378137,BaseY:0,BaseZ:0,VQ:2,VX:1,VY:2,VZ:2})],'RTK');
  const m=geometryDiagnostics(r).diagnostics!;expect(m[0]).toMatchObject({BaselineE:2,BaselineN:3,BaselineU:0,Speed:null});expect(m[0].Baseline).toBeCloseTo(Math.sqrt(13));expect(m[1]).toMatchObject({Baseline:null,Speed:3});
 });
 it('exports current raw native columns in metres and safely preserves signed values and labels',()=>{
  const r=result('a"<b>',[row(0,{ZWD:-.1,ZWDUCor:-1,BaseX:-2000000})]);const csv=diagnosticsCsv([r]);expect(csv).toContain('"ZWD"');expect(csv).toContain('"-0.1"');expect(csv).toContain('"-1"');expect(csv).toContain('"a""<b>"');expect(csv).not.toContain('"-100"');
 });
 it('does not evaluate an explicitly disabled AR mode as a failure rate',()=>{
  const r=result('r',[],'RTK');r.analysisConfig={GNSS_ARMode:'0'};
  const a=buildAnalysis([r],{window:{},cohort:'own',baselineId:'r',reference:null,motion:'unknown'});
  expect(a.rows[0].fixedRate).toBeNull();expect(a.rows[0].arEnabled).toBe(false);
 });
});

it('partitions accepted atmosphere into UTC half-hour bins without duplicating boundary epochs',()=>{
 const r=result('a',[row(0,{ZWD:.1}),row(1799,{ZWD:.2}),row(1800,{ZWD:.3})]);
 const stats=atmosphereWindowStats([r]).filter(s=>s.key==='ZWD');expect(stats.map(s=>s.n)).toEqual([2,1]);expect(stats.map(s=>s.median)).toEqual([150,300]);
});

it('keeps exact common-field cohorts across midnight and empty half-hour windows',()=>{
 const a=result('a',[row(86399,{ZWD:.1}),row(86400,{ZWD:.2}),row(90000,{Q:0,solution:'NONE',ZWD:.9})]);
 const b=result('b',[row(86399,{ZWD:.3}),row(86400,{ZWD:null}),row(93600,{ZWD:.4})]);
 const rows=atmosphereWindowStats([a,b],true).filter(s=>s.key==='ZWD');
 expect(rows.map(s=>[s.name,s.n,s.median])).toEqual([['a',1,100],['b',1,300],['a',0,null],['b',0,null],['a',0,null],['b',0,null]]);
 expect(rows[0].window).toBe('2026-10-21 23:30');expect(rows[2].window).toBe('2026-10-22 00:00');
});
