import { utcAxisLabel } from '../time';
import type { ResultSet } from '../../contracts';
import { Chart } from './Charts';
import { NoData } from './common';
import { distinctNames } from './chart-data';
import { chartText, legendStyle, timeAxisStyle, timeSlider, tooltipStyle } from './chart-theme';
import { palette } from '../theme';
export function ProductTimeline({ results }: { results: ResultSet[] }) {
  const components = [
    ['orbit', '轨道'],
    ['clock', '钟差'],
    ['code', '码偏差'],
    ['phase', '相位偏差'],
  ];
  // One result: the component alone; several: component plus the part of the name that differs.
  const short = results.length > 1 ? distinctNames(results.map((r) => r.name)) : results.map(() => '');
  const rows = results
    .flatMap((r, ri) =>
      components.map(([key, label]) => ({
        id: `${r.id}:${key}`,
        name: short[ri] ? `${label} · ${short[ri]}` : label,
        key,
        history: r.productHistory ?? [],
      })),
    )
    .filter((r) => r.history.length);
  if (!rows.length) return <NoData text="此结果未保存产品接收快照；定位日志本身不能还原完整产品覆盖" />;
  const states = [
    { name: '时效有效（至少一颗）', color: '#50cfa8', test: (v: unknown) => typeof v === 'number' && v > 0 },
    { name: '无有效覆盖', color: '#718097', test: (v: unknown) => v === 0 },
    { name: '未知', color: '#b6a0d5', test: (v: unknown) => typeof v !== 'number' },
  ];
  return (
    <Chart
      height={Math.max(280, rows.length * 29 + 100)}
      label="产品时效快照时间线，接收时间 UTC"
      option={{
        animation: false,
        textStyle: chartText,
        legend: legendStyle(190),
        tooltip: { ...tooltipStyle, trigger: 'axis' },
        grid: { left: 190, right: 28, top: 48, bottom: 48 },
        xAxis: { ...timeAxisStyle, type: 'time', axisLabel: { ...chartText, formatter: utcAxisLabel } },
        yAxis: {
          type: 'category',
          inverse: true,
          data: rows.map((r) => r.name),
          axisLabel: { ...chartText, width: 170, overflow: 'truncate' },
          splitLine: { show: true, lineStyle: { color: palette.gridLine } },
        },
        dataZoom: [{ id: 'time-inside', type: 'inside', xAxisIndex: 0 }, timeSlider(0, 5)],
        series: rows.flatMap((r, i) =>
          states.map((s) => ({
            id: `${r.id}:${s.name}`,
            name: s.name,
            type: 'line',
            step: 'end',
            showSymbol: r.history.length === 1,
            symbolSize: 6,
            connectNulls: false,
            lineStyle: { color: s.color, width: 5, type: s.name === '未知' ? 'dashed' : 'solid' },
            itemStyle: { color: s.color },
            data: r.history.map((m, j) => [
              Date.parse(m.time),
              s.test(m[r.key]) || (j + 1 < r.history.length && s.test(r.history[j + 1][r.key])) ? i : null,
            ]),
          })),
        ),
      }}
    />
  );
}
