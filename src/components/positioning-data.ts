import type { Epoch } from '../../contracts';
import { enu } from '../analysis';

export type Xyz = [number, number, number];
export function epochXyz(e: Epoch): Xyz | null {
  const xyz = [e.x, e.y, e.z];
  return xyz.every(v => typeof v === 'number' && Number.isFinite(v)) && Math.hypot(...xyz as number[]) > 1e6 ? xyz as Xyz : null;
}
/** Display-only projection. Missing XYZ must never silently retain another origin. */
export function projectEpochs(epochs: Epoch[], origin: Xyz | null): Epoch[] {
  if (!origin) return epochs;
  return epochs.flatMap(e => {
    const xyz = epochXyz(e);
    if (!xyz) return [];
    const [east, north, up] = enu(xyz, origin);
    return [{ ...e, e: east, n: north, u: up }];
  });
}
const escape = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function positionTooltip(params: unknown, trajectory: boolean): string {
  const items = (Array.isArray(params) ? params : [params]) as {value?: unknown[];marker?:string}[];
  const seen = new Set<string>();
  const rows = items.flatMap(p => {
    const d = p.value;
    if (!Array.isArray(d) || typeof d[0] !== 'number' || typeof d[1] !== 'number') return [];
    const key = `${d[6]}:${d[4]}:${d[3]}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const value = trajectory ? `E ${Number(d[0]).toFixed(4)} m · N ${Number(d[1]).toFixed(4)} m` : `${escape(d[4])} <b>${Number(d[1]).toFixed(4)} m</b>`;
    return [`${escape(d[5])} · ${value} · ${escape(d[2])}`];
  });
  return `${escape(items.find(p => Array.isArray(p.value))?.value?.[3])} UTC<br/>${rows.join('<br/>')}`;
}
