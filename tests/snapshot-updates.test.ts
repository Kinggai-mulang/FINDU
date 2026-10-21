import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {RealtimeSnapshot,ResultSet} from '../contracts';
const bridge=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>bridge);vi.mock('../src/services/files',()=>({isDesktop:()=>false}));
import {WorkbenchEngine} from '../src/services/native-engine';
const poll=(engine:WorkbenchEngine)=>(engine as unknown as {poll:()=>Promise<void>}).poll();
const session=()=>({sessionKey:'a',id:'run-a',label:'a',metrics:{time:'2026-10-01T00:00:01.000Z',Ratio:3},state:'running',history:[{time:'2026-10-01T00:00:00.000Z',FLRMS:.001},{time:'2026-10-01T00:00:01.000Z',FLRMS:.002}],receivedEpochs:2,epochs:[],productHistory:[],logs:[]} as unknown as RealtimeSnapshot);
beforeEach(()=>{bridge.invoke.mockReset();vi.useFakeTimers();});afterEach(()=>vi.useRealTimers());
describe('unchanged polling and lossless live updates',()=>{
 it('retains the exact snapshot and result array when completed data is unchanged, but publishes new logs',async()=>{
  let logs:unknown[]=[];bridge.invoke.mockImplementation(async(c:string)=>structuredClone(c==='native_snapshot'?{tasks:[],logs,concurrency:2}:[]));
  const e=new WorkbenchEngine(),changed=vi.fn();const off=e.subscribe(changed);
  await poll(e);const first=e.getSnapshot(),calls=changed.mock.calls.length;
  for(let i=0;i<5;i++)await poll(e);
  expect(e.getSnapshot()).toBe(first);expect(changed).toHaveBeenCalledTimes(calls);
  logs=[{id:1,time:'2026-10-01T00:00:00Z',level:'info',message:'new log'}];await poll(e);
  expect(e.getSnapshot()).not.toBe(first);expect(e.getSnapshot().results).toBe(first.results);expect(e.getSnapshot().logs.some(l=>l.message==='new log')).toBe(true);off();
 });
 it('keeps same-length history corrections and spikes even if the latest epoch and received count did not change',async()=>{
  const raw=session();bridge.invoke.mockImplementation(async(c:string)=>structuredClone(c==='native_snapshot'?{tasks:[],logs:[],concurrency:2}:c==='realtime_overview'?[raw]:raw));
  const e=new WorkbenchEngine();e.selectLive('a');await poll(e);const old=e.getSnapshot().realtime;
  await poll(e);expect(e.getSnapshot().realtime).toBe(old);
  raw.history[0].FLRMS=12.345;await poll(e);
  expect(e.getSnapshot().realtime?.history[0].FLRMS).toBe(12.345);expect(old?.history[0].FLRMS).toBe(.001);
  expect(e.getSnapshot().realtime?.receivedEpochs).toBe(2);
 });
 it('updates corrected comparison records, preserves unchanged results and allows reopening after clear',async()=>{
  const r:Omit<ResultSet,'config'>={id:'result-a',name:'a',source:'ipspos',station:'a',solutionMode:'RTK',epochs:[],diagnostics:[{time:'2026-10-01T00:00:00Z',solution:'FLOAT',Q:5,FLRMS:.001}]};
  bridge.invoke.mockImplementation(async(c:string)=>structuredClone(c==='realtime_results'?[r]:c==='native_snapshot'?{tasks:[],logs:[],concurrency:2}:[session()]));
  const e=new WorkbenchEngine();e.setAnalysisVisible(true);await e.compareLive(['a']);await poll(e);
  const first=e.getSnapshot().results.find(v=>v.id===r.id);await poll(e);expect(e.getSnapshot().results.find(v=>v.id===r.id)).toBe(first);
  r.diagnostics![0].FLRMS=9;await poll(e);expect(e.getSnapshot().results.find(v=>v.id===r.id)?.diagnostics?.[0].FLRMS).toBe(9);
  e.clearLiveComparison();expect(e.getSnapshot().results.some(v=>v.id===r.id)).toBe(false);await e.compareLive(['a']);expect(e.getSnapshot().results.some(v=>v.id===r.id)).toBe(true);
 });
});
