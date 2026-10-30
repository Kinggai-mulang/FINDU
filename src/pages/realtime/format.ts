import type { RealtimeMetrics, RealtimeStream } from '../../../contracts';

/** Labels and value formatting shared by the realtime monitor views. */
export const stateNames = {
  idle: '尚未启动',
  starting: '正在启动',
  running: '实时运行',
  stopping: '正在停止',
  stopped: '已停止',
  failed: '会话失败',
};
export const componentNames = { orbit: '轨道', clock: '钟差', code: '码偏差 / OSB', phase: '相位偏差 / OSB' };
export const roleNames: Record<string, string> = {
  BASE: '基站观测流',
  ROVE: '观测流',
  PROD: '主产品流',
  PRODUCT: '主产品流',
  BIAS: '独立偏差流',
  ATMO: '大气流',
};
export function formatBytes(n: number) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
}
export const definitions: Record<string, string> = {
  Obs: '观测卫星数',
  OC: '轨道钟差支持卫星数（配置排除后，高度角筛选前）',
  FloIn: '进入观测更新的卫星数',
  FloUse: '被接受更新所用卫星数',
  HDOP: '浮点解水平 DOP',
  VDOP: '浮点解垂直 DOP',
  FPRMS: '浮点后验伪距残差 RMS / m',
  FLRMS: '浮点后验载波残差 RMS / m',
  PNRMS: '伪距标准化后验残差 RMS',
  LNRMS: '载波标准化后验残差 RMS',
  FltR: '滤波重置',
  AmbR: '本历元初始化或重置的模糊度弧数',
  SlS: '周跳卫星数',
  SlL: '周跳信号数',
  Disc: '相位偏差不连续计数',
  Ratio: '本历元有效整数搜索 Ratio；不等同于已确认固定',
  FixS: '已确认固定的目标卫星数，不含参考端点',
  FixA: '已确认独立模糊度约束数',
  CanS: '至少一个频率通过现有检查的 AR 候选卫星数',
  ADOP: '模糊度 DOP / cycle',
  AHDOP: '固定解水平 DOP',
  AVDOP: '固定解垂直 DOP',
};
export function val(m: RealtimeMetrics | null | undefined, k: string, d = 0) {
  const v = m?.[k];
  return typeof v === 'number' && v >= 0 ? v.toFixed(d) : '—';
}
export function streamLabel(s: RealtimeStream, now: number, active: boolean) {
  if (!active) return { label: '会话已停止', color: 'default' };
  if (s.state === 1) return { label: '连接中', color: 'processing' };
  if (s.state !== 2)
    return {
      label: s.state === 3 ? (s.httpStatus ? '响应拒绝 · HTTP ' + s.httpStatus : '连接异常') : '等待重连',
      color: 'error',
    };
  if (!s.lastArrival) return { label: '已连接 · 等待数据', color: 'warning' };
  if (now - s.lastArrival > 10) return { label: '接收停滞', color: 'warning' };
  return { label: '正在接收', color: 'success' };
}
