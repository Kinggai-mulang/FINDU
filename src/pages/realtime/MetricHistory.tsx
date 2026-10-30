import { memo } from 'react';
import type { RealtimeMetrics } from '../../../contracts';
import { Chart } from '../../components/Charts';
import { NoData } from '../../components/common';
import { fileColors } from '../../components/chart-data';
import { utcAxisLabel } from '../../time';
import { val } from './format';
import { chartText, legendStyle, timeAxisStyle, tooltipStyle, valueAxisStyle } from '../../components/chart-theme';

/** Small time-series panel for product counts and ages in the realtime monitor. */
export const MetricHistory = memo(
  function MetricHistory({
    history,
    keys,
    label,
    unit,
  }: {
    history: RealtimeMetrics[];
    keys: string[];
    label: string;
    unit: string;
  }) {
    const available = history.some((m) => keys.some((k) => typeof m[k] === 'number'));
    if (!available)
      return (
        <>
          <NoData text={history.length ? '日志已读取，当前未提供这些诊断值' : '等待逐历元诊断日志'} />
          <div className="chart-note">{keys.join(' / ')} · 未提供的值不会填成 0</div>
        </>
      );
    return (
      <div>
        <Chart
          height={230}
          label={label}
          option={{
            animation: false,
            color: fileColors,
            textStyle: chartText,
            legend: legendStyle(58),
            tooltip: { ...tooltipStyle, trigger: 'axis' },
            grid: { left: 58, right: 22, top: 50, bottom: 35 },
            xAxis: { ...timeAxisStyle, type: 'time', axisLabel: { ...chartText, formatter: utcAxisLabel } },
            yAxis: { ...valueAxisStyle(unit), type: 'value', scale: true },
            series: keys.map((k) => ({
              name:
                (
                  {
                    orbit: '轨道',
                    clock: '钟差',
                    code: '码偏差',
                    phase: '相位偏差',
                    orbitAge: '轨道',
                    clockAge: '钟差',
                    codeAge: '码偏差',
                    phaseAge: '相位偏差',
                  } as Record<string, string>
                )[k] ?? k,
              type: 'line',
              showSymbol: history.length < 3,
              connectNulls: false,
              showAllSymbol: history.length < 3,
              symbolSize: 5,
              data: history.map((m) => [Date.parse(m.time), typeof m[k] === 'number' ? m[k] : null]),
            })),
          }}
        />
        <div className="chart-note">
          {keys.map((k) => `${k}: ${val(history.at(-1), k, ['HDOP', 'VDOP'].includes(k) ? 3 : 0)}`).join(' · ')} · —
          为算法未提供
        </div>
      </div>
    );
  },
  (a, b) =>
    a.history === b.history && a.keys.join('|') === b.keys.join('|') && a.label === b.label && a.unit === b.unit,
);
