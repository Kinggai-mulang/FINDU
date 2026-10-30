import type { SolverConfig, TaskStatus, ResultSet } from '../contracts';

export type SolverMode = 'PPP' | 'RTK' | 'SPP' | 'UNKNOWN';
export function solverMode(r: Pick<ResultSet, 'solutionMode'>): SolverMode {
  return r.solutionMode ?? 'UNKNOWN';
}
export const arEnabled = (r: Pick<ResultSet, 'analysisConfig'>) => r.analysisConfig?.GNSS_ARMode !== '0';

export const defaultConfig: SolverConfig = {
  schemaVersion: 1,
  name: 'PPP 多系统标准模板',
  mode: 'PPP',
  systems: ['GPS', 'BDS', 'GAL'],
  elevationDeg: 10,
  intervalSec: 1,
  productPath: '',
};
export function utcLabel(value: string) {
  return value.slice(11, 19);
}
export const statusText: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};
export const statusColors: Record<TaskStatus, string> = {
  queued: 'default',
  running: 'processing',
  succeeded: 'success',
  failed: 'error',
  cancelled: 'warning',
};
