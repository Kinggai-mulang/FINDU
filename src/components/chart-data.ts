import type { Epoch, Solution } from '../../contracts';

export const fileColors = ['#78adff', '#5bd8bc', '#efba71', '#c4a0f6', '#f28fa5', '#86d4ee'];
export const directionColors = {e:'#78adff',n:'#5bd8bc',u:'#efba71'} as const;
export const solutionGroups = [
  { name: '计算参考', states: ['REFERENCE'], color: '#5bd8bc' },
  { name: '固定解', states: ['FIX', 'HOLD'], color: '#58d8af' },
  { name: '部分固定', states: ['FLOFIX'], color: '#ac9afa' },
  { name: '浮点解', states: ['FLOAT'], color: '#79afff' },
  { name: '码解', states: ['CODE'], color: '#efbd75' },
  { name: '单点解', states: ['SPP', 'SPP_EKF'], color: '#e494a8' },
  { name: '预测 / 无解', states: ['PRE', 'NONE'], color: '#8290a5' },
] as const;
export function solutionColor(solution: Solution) {
  return solutionGroups.find(g => (g.states as readonly string[]).includes(solution))?.color ?? '#8290a5';
}
/** Include the incoming segment at transitions; isolated states remain visible as points. */
export function coloredData(epochs: Epoch[], states: readonly string[], values: (e: Epoch) => number[]) {
  return epochs.map((e, i) => states.includes(e.solution) || (i + 1 < epochs.length && states.includes(epochs[i + 1].solution)) ? [...values(e), e.solution, e.time] : [...values(e).map(() => null), e.solution, e.time]);
}
export function equalExtent(epochs: Epoch[], width: number, height: number) {
  if (!epochs.length) return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for (const e of epochs) { minX=Math.min(minX,e.e);maxX=Math.max(maxX,e.e);minY=Math.min(minY,e.n);maxY=Math.max(maxY,e.n); }
  const cx=(minX+maxX)/2,cy=(minY+maxY)/2;
  const unit=Math.max((maxX-minX)/Math.max(width,1),(maxY-minY)/Math.max(height,1),0.002/Math.max(height,1))*1.12;
  return {minX:cx-unit*width/2,maxX:cx+unit*width/2,minY:cy-unit*height/2,maxY:cy+unit*height/2};
}
