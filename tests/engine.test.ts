import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MockEngineService, limits } from '../src/services/engine';
import { defaultConfig, statistics } from '../src/domain';

beforeEach(()=>vi.useFakeTimers());afterEach(()=>vi.useRealTimers());
const request=()=>({input:'BAUT.24o',outputDir:'Results',config:structuredClone(defaultConfig),simulateFailure:false});
it('队列串行、参数为快照、完成结果可复核',()=>{
  const s=new MockEngineService();const unsubscribe=s.subscribe(()=>{});const r=request();const id=s.createTask(r);r.config.mode='RTK';const second=s.createTask(request());
  vi.advanceTimersByTime(1000);expect(s.getSnapshot().tasks.find(t=>t.id===id)?.status).toBe('running');expect(s.getSnapshot().tasks.find(t=>t.id===second)?.status).toBe('queued');
  vi.advanceTimersByTime(13000);const task=s.getSnapshot().tasks.find(t=>t.id===id)!;expect(task.status).toBe('succeeded');expect(task.request.config.mode).toBe('PPP');
  const result=s.getSnapshot().results.find(r=>r.id===task.resultId)!;expect(statistics(result.epochs).validEpochs).toBe(1800);unsubscribe();
});
it('取消不会产生结果，失败记录原因，终态不能复活',()=>{
  const s=new MockEngineService();const off=s.subscribe(()=>{});const a=s.createTask(request());s.cancelTask(a);const b=s.createTask({...request(),simulateFailure:true});vi.advanceTimersByTime(20000);
  expect(s.getSnapshot().tasks.find(t=>t.id===a)?.status).toBe('cancelled');const task=s.getSnapshot().tasks.find(t=>t.id===b)!;expect(task.status).toBe('failed');expect(task.error).toContain('覆盖不足');s.cancelTask(b);expect(s.getSnapshot().tasks.find(t=>t.id===b)?.status).toBe('failed');expect(s.getSnapshot().results.length).toBe(3);off();
});
it('多次订阅或切页不重复启动数据流，缓存有界，停止后不再追加',()=>{
  const s=new MockEngineService();const a=s.subscribe(()=>{});const b=s.subscribe(()=>{});s.startLive();s.startLive();vi.advanceTimersByTime(1000);expect(s.getSnapshot().live.epochs.length).toBe(1);a();
  vi.advanceTimersByTime(610000);expect(s.getSnapshot().live.epochs.length).toBe(limits.liveEpochs);s.stopLive();const count=s.getSnapshot().live.epochs.length;vi.advanceTimersByTime(1000);expect(s.getSnapshot().live.epochs.length).toBe(count);
  s.setStation('BAUT');expect(s.getSnapshot().live.epochs).toEqual([]);expect(s.getSnapshot().live.running).toBe(false);b();expect(vi.getTimerCount()).toBe(0);
});
it('日志与任务队列有边界，拒绝坏配置',()=>{
  const s=new MockEngineService();for(let i=0;i<300;i++){s.startLive();s.stopLive();}expect(s.getSnapshot().logs.length).toBe(limits.logs);
  for(let i=0;i<10;i++)s.createTask(request());expect(()=>s.createTask(request())).toThrow('10');expect(()=>s.createTask({...request(),config:{...defaultConfig,systems:[]}})).toThrow();
});
it('保留队列内任务，历史清理不会丢失运行任务',()=>{
  const s=new MockEngineService();const off=s.subscribe(()=>{});const first=s.createTask(request());vi.advanceTimersByTime(1000);
  for(let i=0;i<120;i++){const id=s.createTask(request());s.cancelTask(id);}
  expect(s.getSnapshot().tasks.length).toBe(limits.tasks);expect(s.getSnapshot().tasks.find(t=>t.id===first)?.status).toBe('running');off();
});
