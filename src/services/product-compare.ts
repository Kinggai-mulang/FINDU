import type { ProductComparison } from '../../contracts';

export const systemNames: Record<string, string> = { G: 'GPS', R: 'GLONASS', E: 'Galileo', C: '北斗', J: 'QZSS' };
export const systemKeys: Record<string, string> = { G: 'GPS', R: 'GLO', E: 'GAL', C: 'BDS', J: 'QZSS' };

export const cm = (metres: number | null | undefined, digits = 1) =>
  metres === null || metres === undefined || !Number.isFinite(metres) ? '—' : (metres * 100).toFixed(digits);

const csvText = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** Per-satellite table as CSV, one block per compared product. Distances are in centimetres. */
export function comparisonCsv(results: ProductComparison[]): string {
  const lines = [
    '产品,卫星,系统,轨道历元,径向均值cm,径向RMS cm,切向RMS cm,法向RMS cm,三维RMS cm,三维最大cm,钟差标准差cm,钟差阶跃,SISRE cm,参考匹配率,异常,轨道处理,判别依据,去除径向常量cm',
  ];
  for (const result of results) {
    for (const s of result.satellites) {
      lines.push(
        [
          csvText(result.name),
          s.sat,
          s.system,
          s.d3.n,
          cm(s.r.mean, 2),
          cm(s.r.rms, 2),
          cm(s.a.rms, 2),
          cm(s.c.rms, 2),
          cm(s.d3.rms, 2),
          cm(s.d3.max, 2),
          cm(s.clock.n ? s.clock.std : null, 2),
          s.clockJumps,
          cm(s.sisre, 2),
          s.coverage.toFixed(3),
          s.outlier ? '是' : '',
          result.apc ? '去径向常量' : '保持原值',
          csvText(result.orbitDecision?.reason ?? '旧版结果，未记录判别依据'),
          cm(result.orbitDecision?.radialOffsets[s.sat], 4),
        ].join(','),
      );
    }
  }
  return lines.join('\r\n') + '\r\n';
}
