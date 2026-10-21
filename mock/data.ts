import type { Epoch, ResultSet, SolverConfig } from '../contracts';
import { defaultConfig } from '../src/domain';

export const stations = [{id:'WHU01',name:'武汉 · WHU01',location:'参考站 / 武汉'}, {id:'BAUT',name:'包岑 · BAUT',location:'参考站 / 包岑'}, {id:'SZ02',name:'深圳 · SZ02',location:'监测点 / 深圳'}];
export const sampleInputs = [{value:'BAUT_2024019.24o',label:'BAUT · RINEX 观测示例'}, {value:'WHU_20261016.rtcm',label:'WHU01 · RTCM 观测示例'}];
// Deterministic fixtures: all charts and metrics are derived from these epochs.
export function makeEpoch(index: number, seed: number, start: number, intervalSec=1): Epoch {
  const settling = Math.exp(-index/42);
  const scale = 1 + seed*0.24;
  return { time:new Date(start+index*intervalSec*1000).toISOString(), e:scale*(0.012*Math.sin(index*.17+seed)+0.009*Math.cos(index*.71)+0.16*settling), n:scale*(0.009*Math.sin(index*.11)+0.007*Math.cos(index*.51+seed)-0.1*settling), u:scale*(0.023*Math.sin(index*.09+seed)+0.016*Math.cos(index*.37)+0.26*settling), satellites:24+((index*7+seed*3)%13), solution:index<35?'SPP':index<130||index%91<4?'FLOAT':'FIX' };
}
export function makeResult(id:string,name:string,seed:number,config:SolverConfig=defaultConfig,station='BAUT'): ResultSet {
  return {id,name,station,source:'mock',config:structuredClone(config),epochs:Array.from({length:1800},(_,i)=>makeEpoch(i,seed,Date.UTC(2026,9,16,0,0,0),config.intervalSec))};
}
export const initialResults = [makeResult('sample-a','PPP · 标准策略',0),makeResult('sample-b','PPP · 对比策略',2),makeResult('sample-c','RTK · 对照样例',1,{...defaultConfig,name:'RTK 对照模板',mode:'RTK'})];
