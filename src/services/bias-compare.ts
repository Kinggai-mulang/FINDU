import type { BiasComparison, BiasKind, BiasRow, BiasSign } from '../../contracts';

/** Short account of the sign a test product was compared with, empty when it was used as given. */
export function signText(sign: BiasSign | undefined): string {
  if (!sign || (sign.code > 0 && sign.phase > 0)) return '';
  const what = sign.code < 0 && sign.phase < 0 ? '码和相位偏差' : sign.code < 0 ? '码偏差' : '相位偏差';
  return `${what}已取反${sign.auto ? '（自动判断）' : ''}`;
}

/** Display order: the ambiguity-fixing quantities first. */
export const kindOrder: BiasKind[] = ['wl', 'nlc', 'nl', 'code', 'codec', 'dcb', 'phase'];
export const kindNames: Record<BiasKind, string> = {
  wl: '宽巷（WL）',
  nl: '窄巷（NL）',
  nlc: '窄巷+钟差（实验）',
  code: '码偏差',
  codec: '码偏差+钟差',
  dcb: '码间差（DCB）',
  phase: '相位偏差',
};
export const kindNotes: Record<BiasKind, string> = {
  wl: '比较同卫星、同信号对的码与相位组合差，去公共基准后取小数周。±0.1 周仅为差异统计门限，不是固定成功率；须确认原始产品的整数标志、宽巷分组及 MW 一致性。Bias-SINEX 通常不保留这些 SSR 标志，不能单凭此图判断产品能否固定。',
  nl: '窄巷：宽巷固定后第一频率相位偏差的小数周。每颗卫星的常数取决于整周和各产品自己的钟差基准，不可比，已经去掉；这里比较的是它在一天里的波动，越小越稳。波动里包含两份产品钟差的差异。',
  nlc: '窄巷+钟差：把两份产品的卫星钟差之差一并算进窄巷（电离层无关相位偏差减去钟差，再减去带码的宽巷），同样去掉每颗卫星的常数，只看日内波动。需要两份产品都给钟差文件。实验性功能：和窄巷对照，能看出波动有多少来自钟差。',
  code: '扣除每个系统每个信号的公共基准后，对比产品与参考的差，单位 ns（1 ns ≈ 0.30 m）。',
  codec:
    '码偏差减去卫星钟差（ns）。两份产品的钟差参考信号不同时（北斗常见），码偏差会随钟差基准一起偏移，加上钟差后才一致；参考信号相同时，加钟差反而会带进钟差的常数差，请和“码偏差”对照着看。需要两份产品都给钟差文件。',
  dcb: '同一颗卫星两个码信号的偏差之差，不含基准，是最干净的码偏差比较，单位 ns。',
  phase:
    '单个相位信号的小数周差，未联合消除两份产品各自的卫星钟差。差值较大不能单独证明整数特性或解码有误；需结合配套钟差、信号交集和原始 SSR 整数/连续性标志检查。',
};

export const unitLabel = (unit: BiasRow['unit']) => (unit === 'ns' ? 'ns' : '周');
export const digits = (unit: BiasRow['unit']) => (unit === 'ns' ? 3 : 3);
export const fixed = (value: number | null | undefined, unit: BiasRow['unit']) =>
  value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits(unit));

/** Rows with no meaningful comparison across analysis centres get a lighter treatment in the table. */
export const isReferenceOnly = (kind: BiasKind) => kind === 'phase';
export const isCyclic = (kind: BiasKind) => kind === 'phase' || kind === 'wl' || kind === 'nl' || kind === 'nlc';

/** Label of grid epoch `k`, e.g. `09-19 17:35`; the products' own time system, no zone shift. */
export function epochLabel(result: Pick<BiasComparison, 'start' | 'step'>, k: number): string {
  const stamp = new Date(Date.parse(`${result.start}Z`) + k * result.step * 1000).toISOString();
  return `${stamp.slice(5, 10)} ${stamp.slice(11, 16)}`;
}

export function biasCsv(results: BiasComparison[]): string {
  const lines = ['产品,卫星,系统,信号,类型,均值,RMS,日内标准差,历元数,异常,单位'];
  for (const result of results) {
    for (const item of result.items) {
      const unit = isCyclic(item.kind) ? '周' : 'ns';
      lines.push(
        [
          JSON.stringify(result.name),
          item.sat,
          item.system,
          JSON.stringify(item.signal),
          item.kind,
          item.mean.toFixed(5),
          item.rms.toFixed(5),
          item.temporalStd.toFixed(5),
          item.n,
          item.outlier ? '是' : '',
          unit,
        ].join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}
