import capacity from '../../contracts/capacity.json';
import {invoke} from '@tauri-apps/api/core';
import type {EngineInfo,EngineService,NativeRunRequest,NativeSnapshot,NativeTask,ResultSet,Task,RealtimeSnapshot} from '../../contracts';
import {MockEngineService} from './engine';
import {defaultConfig} from '../domain';
import {isDesktop} from './files';
import {configFromOpt} from './options';
const sameItems=(a:readonly unknown[],b:readonly unknown[])=>a.length===b.length&&a.every((item,i)=>item===b[i]);

/** One polling subscription for the application; overviews omit per-epoch histories. */
export class WorkbenchEngine implements EngineService {
 private mock=new MockEngineService();private listeners=new Set<()=>void>();private snapshot=this.mock.getSnapshot();private native:NativeSnapshot={tasks:[],logs:[],concurrency:2};private results=new Map<string,ResultSet>();
 private timer?:ReturnType<typeof setInterval>;private unsubscribeMock?:()=>void;private polling=false;private errorReported=false;
 private liveSelectionVersion=0;private analysisVisible=false;private realtimeVisible=true;private realtime?:RealtimeSnapshot;private sessions:RealtimeSnapshot[]=[];private selectedLiveId?:string;private comparisonKeys:string[]=[];private liveResults:ResultSet[]=[];
 private publishedInputs:unknown[]=[];private nativeText?:string;private overviewText?:string;private detailText?:string;private comparisonText?:string;
 private mappedTasks=new WeakMap<NativeTask,Task>();
 private visibleAnalysisIds?:Set<string>;
 getSnapshot=()=>this.snapshot;
 private publish=()=>{
  const m=this.mock.getSnapshot();const incoming=[...m.results,...this.results.values(),...this.liveResults];
  const inputs=[m,this.native,this.realtime,this.sessions,this.liveResults,...incoming];
  if(sameItems(inputs,this.publishedInputs))return;
  this.publishedInputs=inputs;
  const results=sameItems(incoming,this.snapshot.results)?this.snapshot.results:incoming;
  this.snapshot={...m,realtime:this.realtime,realtimeSessions:this.sessions,tasks:[...this.native.tasks.map(t=>this.task(t)),...m.tasks],results,logs:[...m.logs.map(l=>l.id===0?{...l,message:'演示服务已就绪；桌面真实任务由 IPSPOS 引擎执行'}:l),...this.native.logs.map(l=>({...l,id:l.id+1000000}))].sort((a,b)=>a.time.localeCompare(b.time)).slice(-500)};
  this.listeners.forEach(fn=>fn());
 };
 private task(t:NativeTask):Task{const cached=this.mappedTasks.get(t);if(cached)return cached;const config=configFromOpt(t.request.document.text,t.name);const mapped:Task={...t,source:'ipspos',request:{input:t.request.document.sourcePath,outputDir:t.outputDir,config,simulateFailure:false},preview:t.preview?{...t.preview,config}as ResultSet:undefined};this.mappedTasks.set(t,mapped);return mapped;}
 private setLiveResults(incoming:Omit<ResultSet,'config'>[]){const text=JSON.stringify(incoming);if(text===this.comparisonText)return;this.comparisonText=text;this.liveResults=incoming.map(r=>({...r,config:{...defaultConfig,name:r.name,mode:r.solutionMode??defaultConfig.mode}}));}
 subscribe=(fn:()=>void)=>{this.listeners.add(fn);if(!this.unsubscribeMock){this.unsubscribeMock=this.mock.subscribe(this.publish);if(isDesktop()){void this.poll();this.timer=setInterval(()=>void this.poll(),1000);}}return ()=>{this.listeners.delete(fn);if(!this.listeners.size){this.unsubscribeMock?.();this.unsubscribeMock=undefined;clearInterval(this.timer);this.timer=undefined;}};};
 private async poll(){if(this.polling)return;this.polling=true;try{
  const [native,sessions]=await Promise.all([invoke<NativeSnapshot>('native_snapshot'),invoke<RealtimeSnapshot[]>('realtime_overview')]);
  // Compare complete wire values: same-length histories and corrected old epochs must still update.
  const nativeText=JSON.stringify(native),overviewText=JSON.stringify(sessions);
  if(nativeText!==this.nativeText){this.native=native;this.nativeText=nativeText;}
  if(overviewText!==this.overviewText){this.sessions=sessions;this.overviewText=overviewText;}
  let selected=this.selectedLiveId;
  if(selected===undefined&&this.sessions.length)this.selectedLiveId=selected=this.sessions[0].sessionKey;
  const selectionVersion=this.liveSelectionVersion;
  const owner=this.sessions.find(s=>s.sessionKey===selected);
  const showDetail=this.realtimeVisible&&!this.analysisVisible;
  const detail=showDetail&&owner?await invoke<RealtimeSnapshot>('realtime_snapshot',{sessionId:owner.sessionKey}):undefined;
  if(this.liveSelectionVersion===selectionVersion&&this.selectedLiveId===selected&&showDetail){
   const valid=detail&&detail.sessionKey===selected&&detail.id===owner?.id?detail:undefined;
   const text=valid?JSON.stringify(valid):undefined;
   if(!valid||text!==this.detailText||!this.realtime){this.realtime=valid;this.detailText=text;}
  }
  if(this.comparisonKeys.length&&this.analysisVisible&&(this.visibleAnalysisIds===undefined||this.comparisonKeys.some(k=>this.visibleAnalysisIds!.has(`live-${k}`)))){const keys=this.comparisonKeys.filter(k=>this.sessions.some(s=>s.sessionKey===k));this.comparisonKeys=keys;this.setLiveResults(await invoke<Omit<ResultSet,'config'>[]>('realtime_results',{ids:keys}));}
  for(const t of this.native.tasks){if(t.resultId&&!this.results.has(t.resultId)){const r=await invoke<Omit<ResultSet,'config'>>('native_result',{id:t.resultId});this.results.set(t.resultId,{...r,config:configFromOpt(t.request.document.text,t.name)});}}
  this.errorReported=false;this.publish();
 }catch(error){if(!this.errorReported){console.error('Native engine poll failed',error);this.errorReported=true;}}finally{this.polling=false;}}
 async submitNative(requests:NativeRunRequest[],concurrency:number){const ids=await invoke<string[]>('submit_native',{requests,concurrency});await this.poll();return ids;}
 selectLive=(id:string)=>{this.liveSelectionVersion++;this.selectedLiveId=id;this.realtime=undefined;this.detailText=undefined;this.publish();if(isDesktop())void this.poll();};
 async compareLive(ids:string[]){if(ids.length>capacity.comparisonResults)throw new Error(`一次最多对比 ${capacity.comparisonResults} 路方案`);const incoming=await invoke<Omit<ResultSet,'config'>[]>('realtime_results',{ids});this.comparisonKeys=ids;this.setLiveResults(incoming);this.publish();return this.liveResults.map(r=>r.id);}
 setAnalysisVisible=(visible:boolean)=>{this.analysisVisible=visible;};
 setRealtimeVisible=(visible:boolean)=>{this.realtimeVisible=visible;};
 setVisibleAnalysisResults=(ids:string[])=>{this.visibleAnalysisIds=new Set(ids);};
 removeLive=async(key:string)=>{
  await invoke('remove_realtime',{sessionId:key});
  this.comparisonKeys=this.comparisonKeys.filter(k=>k!==key);
  this.liveResults=this.liveResults.filter(r=>r.id!==`live-${key}`);
  this.comparisonText=undefined;
  if(this.selectedLiveId===key){this.liveSelectionVersion++;this.selectedLiveId=undefined;this.realtime=undefined;this.detailText=undefined;}
  this.publish();
 };
 clearLiveComparison=()=>{this.comparisonKeys=[];this.liveResults=[];this.comparisonText=undefined;this.publish();};
 info=()=>invoke<EngineInfo>('engine_info');
 dismissNative=async(ids:string[])=>{await invoke('dismiss_native',{ids});ids.forEach(id=>this.results.delete(id));await this.poll();};
 openNativeFolder=(id:string)=>invoke('open_native_folder',{id});
 async importResults(paths:string[]){const incoming=await invoke<Omit<ResultSet,'config'>[]>('import_analysis',{paths});for(const r of incoming){this.results.set(r.id,{...r,config:{...defaultConfig,name:r.name,mode:r.solutionMode??defaultConfig.mode}});}this.publish();return incoming.map(r=>r.id);}
 async openArchived(id:string){const r=await invoke<Omit<ResultSet,'config'>>('open_analysis',{id});this.results.set(r.id,{...r,config:{...defaultConfig,name:r.name,mode:r.solutionMode??defaultConfig.mode}});this.publish();return r.id;}
 createTask=(request:Parameters<EngineService['createTask']>[0])=>this.mock.createTask(request);
 cancelTask=(id:string)=>{if(this.native.tasks.some(t=>t.id===id)){void invoke('cancel_native',{id}).then(()=>this.poll()).catch(console.error);}else this.mock.cancelTask(id);};
 setStation=(id:string)=>this.mock.setStation(id);startLive=()=>this.mock.startLive();stopLive=()=>this.mock.stopLive();
}
export const workbenchEngine=new WorkbenchEngine();
