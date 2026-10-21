import type { EngineService, LogEntry, Task, TaskRequest, TaskStatus, WorkbenchSnapshot } from '../../contracts';
import { initialResults, makeEpoch, makeResult } from '../../mock/data';
import { canTransition, validateConfig } from '../domain';

export const limits = {liveEpochs:600, logs:500, tasks:100, results:50};
export class MockEngineService implements EngineService {
  private snapshot: WorkbenchSnapshot = { tasks:[],results:structuredClone(initialResults),logs:[{id:0,time:new Date().toISOString(),level:'info',message:'FINDU 已就绪 · 当前为模拟模式，未连接真实引擎'}],live:{station:'WHU01',running:false,epochs:[]} };
  private listeners = new Set<()=>void>();
  private timer?: ReturnType<typeof setInterval>;
  private seq = 0;
  private liveIndex = 0;
  private liveStart = 0;
  getSnapshot = () => this.snapshot;
  subscribe = (listener:()=>void) => {
    this.listeners.add(listener);
    if(!this.timer) this.timer=setInterval(()=>this.tick(),1000);
    return ()=>{ this.listeners.delete(listener); if(!this.listeners.size) {clearInterval(this.timer); this.timer=undefined;} };
  };
  private publish() { this.snapshot={...this.snapshot}; this.listeners.forEach(fn=>fn()); }
  private log(message:string,level:LogEntry['level']='info',taskId?:string) {
    this.snapshot.logs=[...this.snapshot.logs,{id:++this.seq,time:new Date().toISOString(),message,level,taskId}].slice(-limits.logs);
  }
  createTask = (request:TaskRequest) => {
    const errors=validateConfig(request.config);
    if(!request.input.trim() || !request.outputDir.trim()) errors.push('输入和输出目录不能为空');
    if(errors.length) throw new Error(errors.join('；'));
    if(this.snapshot.tasks.filter(t=>t.status==='queued'||t.status==='running').length>=10) throw new Error('最多同时保留 10 个待处理任务');
    const id=crypto.randomUUID();
    const task:Task={id,name:request.input.split(/[\\/]/).pop()!,createdAt:new Date().toISOString(),status:'queued',progress:0,request:structuredClone(request)};
    const active=this.snapshot.tasks.filter(t=>t.status==='queued'||t.status==='running');
    const finished=this.snapshot.tasks.filter(t=>t.status!=='queued'&&t.status!=='running');
    this.snapshot.tasks=[task,...active,...finished.slice(0,limits.tasks-active.length-1)];
    this.log(`任务已加入队列：${task.name}`,'info',id); this.publish(); return id;
  };
  private transition(task:Task,status:TaskStatus,extra:Partial<Task>={}) {
    if(!canTransition(task.status,status)) return;
    this.snapshot.tasks=this.snapshot.tasks.map(t=>t.id===task.id?{...t,status,...extra}:t);
  }
  cancelTask = (id:string) => { const task=this.snapshot.tasks.find(t=>t.id===id); if(task&&canTransition(task.status,'cancelled')) {this.transition(task,'cancelled');this.log('用户取消任务','warn',id);this.publish();} };
  setStation = (station:string) => { if(!['WHU01','BAUT','SZ02'].includes(station)) return; this.liveIndex=0;this.liveStart=Date.now();this.snapshot.live={station,running:false,epochs:[]};this.log(`已切换测站 ${station}，等待启动`);this.publish(); };
  startLive = () => { if(this.snapshot.live.running) return; this.liveStart=Date.now()-this.liveIndex*1000;this.snapshot.live={...this.snapshot.live,running:true};this.log(`开始模拟数据流：${this.snapshot.live.station}`);this.publish(); };
  stopLive = () => { if(!this.snapshot.live.running)return;this.snapshot.live={...this.snapshot.live,running:false};this.log('模拟数据流已停止');this.publish(); };
  private tick() {
    let changed=false;
    if(this.snapshot.live.running) {
      const seed=['WHU01','BAUT','SZ02'].indexOf(this.snapshot.live.station);
      const epoch=makeEpoch(this.liveIndex++,seed,this.liveStart);
      this.snapshot.live={...this.snapshot.live,epochs:[...this.snapshot.live.epochs,epoch].slice(-limits.liveEpochs)};
      if(this.liveIndex%10===0) this.log(`${this.snapshot.live.station} · ${epoch.satellites} 颗卫星 · ${epoch.solution}`);
      changed=true;
    }
    const task=this.snapshot.tasks.find(t=>t.status==='running') ?? [...this.snapshot.tasks].reverse().find(t=>t.status==='queued');
    if(task) {
      if(task.status==='queued') { this.transition(task,'running'); this.log('模拟引擎启动，开始读取示例观测','info',task.id); }
      else {
        const progress=Math.min(100,task.progress+8);
        if(task.request.simulateFailure&&progress>=48) {this.transition(task,'failed',{error:'模拟故障：产品覆盖不足，请检查产品时间范围'});this.log('模拟产品覆盖不足，任务失败','error',task.id);}
        else if(progress===100) {
          const result=makeResult(`result-${task.id}`,`${task.request.config.mode} · ${task.name} · ${task.id.slice(0,6)}`,1,task.request.config,task.name.startsWith('WHU')?'WHU01':'BAUT');
          this.snapshot.results=[...this.snapshot.results,result].slice(-limits.results);
          this.transition(task,'succeeded',{progress:100,resultId:result.id});this.log('模拟任务完成，结果已加入分析对比；未写出真实解算文件','info',task.id);
        } else { this.snapshot.tasks=this.snapshot.tasks.map(t=>t.id===task.id?{...t,progress}:t);this.log(`处理示例历元 · ${progress}%`,'info',task.id); }
      }
      changed=true;
    }
    if(changed) this.publish();
  }
}
export const engine: EngineService = new MockEngineService();
