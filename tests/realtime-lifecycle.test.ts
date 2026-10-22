import {beforeEach,expect,it,vi} from 'vitest';
import type {RealtimeSnapshot,ResultSet} from '../contracts';
const bridge=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>bridge);vi.mock('../src/services/files',()=>({isDesktop:()=>false}));
import {WorkbenchEngine} from '../src/services/native-engine';
const poll=(e:WorkbenchEngine)=>(e as unknown as {poll:()=>Promise<void>}).poll();
const session=()=>({sessionKey:'a',id:'run-a',state:'running',history:[{time:'2026-10-01T00:00:00Z',Q:5,ZWD:.1}],epochs:[],productHistory:[],logs:[]} as unknown as RealtimeSnapshot);
beforeEach(()=>{bridge.invoke.mockReset();});

it('keeps lightweight status alive on other pages, stops detail transfer and resumes corrected records',async()=>{
 const raw=session();bridge.invoke.mockImplementation(async(c:string)=>structuredClone(c==='native_snapshot'?{tasks:[],logs:[],concurrency:2}:c==='realtime_overview'?[raw]:raw));
 const e=new WorkbenchEngine();e.selectLive('a');await poll(e);expect(e.getSnapshot().realtime?.history[0].ZWD).toBe(.1);
 e.setRealtimeVisible(false);bridge.invoke.mockClear();raw.history[0].ZWD=.9;
 for(let i=0;i<5;i++)await poll(e);
 expect(bridge.invoke.mock.calls.filter(([c])=>c==='realtime_snapshot')).toHaveLength(0);
 expect(bridge.invoke.mock.calls.filter(([c])=>c==='realtime_overview')).toHaveLength(5);
 e.setRealtimeVisible(true);await poll(e);expect(e.getSnapshot().realtime?.history[0].ZWD).toBe(.9);
});
it('releases removed live comparisons while keeping a rejected active removal intact',async()=>{
 const result={id:'live-a',name:'a',source:'ipspos',station:'a',epochs:[],diagnostics:[{time:'2026-10-01T00:00:00Z',Q:5,solution:'FLOAT'}]} as Omit<ResultSet,'config'>;
 let reject=true;
 bridge.invoke.mockImplementation(async(c:string)=>{if(c==='realtime_results')return[result];if(c==='remove_realtime'){if(reject)throw Error('请先停止');return;}throw Error(c);});
 const e=new WorkbenchEngine();await e.compareLive(['a']);
 await expect(e.removeLive('a')).rejects.toThrow('请先停止');expect(e.getSnapshot().results.some(r=>r.id==='live-a')).toBe(true);
 reject=false;await e.removeLive('a');expect(e.getSnapshot().results.some(r=>r.id==='live-a')).toBe(false);
});

it('keeps live comparisons when viewing an archive and resumes them without deleting cached statistics',async()=>{
 const r={id:'live-a',name:'a',source:'ipspos',station:'a',epochs:[],diagnostics:[{time:'2026-10-01T00:00:00Z',Q:5,solution:'FLOAT',ZWD:.1}]} as Omit<ResultSet,'config'>;
 bridge.invoke.mockImplementation(async(c:string)=>structuredClone(c==='realtime_results'?[r]:c==='native_snapshot'?{tasks:[],logs:[],concurrency:2}:[session()]));
 const e=new WorkbenchEngine();e.setAnalysisVisible(true);await e.compareLive(['a']);const saved=e.getSnapshot().results.find(v=>v.id==='live-a');
 e.setVisibleAnalysisResults(['archived']);bridge.invoke.mockClear();r.diagnostics![0].ZWD=.9;await poll(e);
 expect(bridge.invoke.mock.calls.some(([cmd])=>cmd==='realtime_results')).toBe(false);expect(e.getSnapshot().results.find(v=>v.id==='live-a')).toBe(saved);
 e.setVisibleAnalysisResults(['live-a']);await poll(e);expect(e.getSnapshot().results.find(v=>v.id==='live-a')?.diagnostics?.[0].ZWD).toBe(.9);
});

it('compares six live sessions and rejects a seventh before requesting native history',async()=>{
 const ids=Array.from({length:6},(_,i)=>`session-${i}`);bridge.invoke.mockResolvedValue(ids.map(id=>({id:`live-${id}`,name:id,station:'same',source:'ipspos',epochs:[],diagnostics:[]})));
 const e=new WorkbenchEngine();expect(await e.compareLive(ids)).toHaveLength(6);expect(bridge.invoke).toHaveBeenCalledWith('realtime_results',{ids});bridge.invoke.mockClear();await expect(e.compareLive([...ids,'seventh'])).rejects.toThrow('6');expect(bridge.invoke).not.toHaveBeenCalled();
});
