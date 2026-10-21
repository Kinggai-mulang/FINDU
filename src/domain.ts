import type { Epoch, SolverConfig, Statistics, TaskStatus, ResultSet } from '../contracts';

export type SolverMode='PPP'|'RTK'|'SPP'|'UNKNOWN';
export function solverMode(r:Pick<ResultSet,'solutionMode'|'source'|'config'>):SolverMode {
  return r.solutionMode??(r.source==='mock'?r.config.mode:'UNKNOWN');
}
export const arEnabled=(r:Pick<ResultSet,'analysisConfig'>)=>r.analysisConfig?.GNSS_ARMode!=='0';

export const defaultConfig: SolverConfig = {schemaVersion:1, name:'PPP 多系统标准模板', mode:'PPP', systems:['GPS','BDS','GAL'], elevationDeg:10, intervalSec:1, productPath:''};
export function validateConfig(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['配置必须为 JSON 对象'];
  const c = value as Record<string, unknown>;
  const errors: string[] = [];
  if(c.schemaVersion !== 1) errors.push('仅支持 FINDU 配置版本 1');
  if(typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80) errors.push('模板名称须为 1–80 个字符');
  if(!['SPP','RTK','PPP'].includes(String(c.mode))) errors.push('解算模式无效');
  if(!Array.isArray(c.systems) || !c.systems.length || c.systems.some(s=>!['GPS','BDS','GAL','GLO'].includes(s)) || new Set(c.systems).size !== c.systems.length) errors.push('请选择有效且不重复的卫星系统');
  if(typeof c.elevationDeg !== 'number' || !Number.isFinite(c.elevationDeg) || c.elevationDeg < 0 || c.elevationDeg > 60) errors.push('截止高度角须在 0–60° 之间');
  if(typeof c.intervalSec !== 'number' || !Number.isFinite(c.intervalSec) || c.intervalSec < 0.1 || c.intervalSec > 3600) errors.push('采样间隔须在 0.1–3600 秒之间');
  if(typeof c.productPath !== 'string' || c.productPath.length > 1024) errors.push('产品路径格式无效或过长');
  return errors;
}
export function parseConfig(text: string): SolverConfig {
  const value: unknown = JSON.parse(text);
  const errors = validateConfig(value);
  if(errors.length) throw new Error(errors.join('；'));
  const c = value as SolverConfig;
  return { schemaVersion:1, name:c.name.trim(), mode:c.mode, systems:[...c.systems], elevationDeg:c.elevationDeg, intervalSec:c.intervalSec, productPath:c.productPath };
}
export function statistics(epochs: Epoch[]): Statistics {
  const valid = epochs.filter(p=>[p.e,p.n,p.u].every(Number.isFinite));
  const rms = (key:'e'|'n'|'u') => valid.length ? Math.sqrt(valid.reduce((sum,p)=>sum+p[key]**2,0)/valid.length) : 0;
  return {rmsE:rms('e'),rmsN:rms('n'),rmsU:rms('u'),fixedRate:valid.length?valid.filter(p=>p.solution==='FIX'||p.solution==='HOLD').length/valid.length:0,validEpochs:valid.length,totalEpochs:epochs.length};
}
const transitions: Record<TaskStatus, TaskStatus[]> = {queued:['running','cancelled'],running:['succeeded','failed','cancelled'],succeeded:[],failed:[],cancelled:[]};
export function canTransition(from: TaskStatus, to: TaskStatus) { return transitions[from].includes(to); }
export function utcLabel(value: string) { return value.slice(11,19); }
export const statusText: Record<TaskStatus,string> = {queued:'排队中',running:'运行中',succeeded:'已完成',failed:'失败',cancelled:'已取消'};
export const statusColors: Record<TaskStatus,string> = {queued:'default',running:'processing',succeeded:'success',failed:'error',cancelled:'warning'};
