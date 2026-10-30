import { memo, useMemo } from 'react';
import { Chart } from './Charts';
import { NoData } from './common';
import { distinctNames, fileColors } from './chart-data';
import {
  chartText,
  legendStyle,
  timeAxisStyle,
  timeSlider,
  tooltipStyle,
  valueAxisStyle,
  valueSlider,
} from './chart-theme';
import { chartSamples } from '../diagnostics';
import { DISPLAY_COLUMNS, decimateIndices } from './decimate';
import { useDetail } from './detail-context';
import { utcAxisLabel } from '../time';
import type { RealtimeMetrics } from '../../contracts';

export function diagnosticValue(raw: unknown, scale = 1, logarithmic = false): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || (logarithmic && raw < 0)) return null;
  return logarithmic ? Math.max(0.0001, raw) : raw * scale;
}
const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
type Dataset = { id: string; name: string; diagnostics?: RealtimeMetrics[]; color?: string };
type Props = {
  datasets: Dataset[];
  fields: string[];
  label: string;
  unit?: string;
  valueScale?: number;
  logarithmic?: boolean;
  onTimeRange?: (start: number, end: number) => void;
  timeDomain?: { start?: number; end?: number };
  displayBounds?: [number, number];
  labels?: Record<string, string>;
  states?: Record<number, string>;
  onInspect?: (time: number) => void;
  height?: number;
};

export const DiagnosticChart = memo(
  function DiagnosticChart({
    datasets,
    fields,
    label,
    unit = '',
    valueScale = 1,
    logarithmic = false,
    onTimeRange,
    timeDomain,
    displayBounds,
    labels = {},
    states,
    onInspect,
    height = 270,
  }: Props) {
    const detail = useDetail();
    const bounds = logarithmic ? ([0.0001, 1] as [number, number]) : displayBounds;
    const boundsKey = bounds?.join(',');
    const fieldsKey = fields.join('|');
    const statesKey = JSON.stringify(states);
    const labelsKey = JSON.stringify(labels);
    const { series, outside, has } = useMemo(() => {
      const has = datasets.some((d) =>
        d.diagnostics?.some((m) => fields.some((k) => diagnosticValue(m[k], valueScale, logarithmic) !== null)),
      );
      let outside = 0;
      // Compared results differ only in a short part of their file names; the legend shows just that part.
      const short = distinctNames(datasets.map((d) => d.name));
      const series = datasets.flatMap((d, i) =>
        fields.flatMap((k, j) => {
          const all = chartSamples(d.diagnostics ?? [], k, valueScale, logarithmic, bounds);
          // Gap markers (null) and out-of-window points always survive thinning.
          const picked =
            detail === 'all'
              ? undefined
              : decimateIndices(
                  all.map((v) => v[0] as number),
                  all.map((v) => v[1]),
                  DISPLAY_COLUMNS,
                  (index) => all[index][1] === null || all[index][3] !== 0,
                );
          const data = !picked || picked.length === all.length ? all : picked.map((index) => all[index]);
          const overflow = all.filter((v) => v[3]);
          outside += overflow.length;
          const color =
            datasets.length > 1
              ? (d.color ?? fileColors[i % fileColors.length])
              : fields.length === 1
                ? (d.color ?? fileColors[0])
                : fileColors[j % fileColors.length];
          const name = datasets.length > 1 ? `${short[i]} · ${labels[k] ?? k}` : (labels[k] ?? k);
          const line = {
            id: `${d.id}:${k}`,
            name,
            type: 'line' as const,
            showSymbol: data.length < 3,
            symbolSize: 4,
            connectNulls: false,
            step: states ? ('end' as const) : undefined,
            encode: { x: 0, y: 1 },
            lineStyle: {
              width: 1.7,
              color,
              type: j % 4 === 3 ? [8, 3, 2, 3] : (['solid', 'dashed', 'dotted'] as const)[j % 4],
            },
            itemStyle: { color },
            data,
          };
          if (!overflow.length) return [line];
          // Points outside the reading window sit on its edge as triangles; tooltips keep the raw value.
          const markers = {
            id: `${d.id}:${k}:outside`,
            name,
            type: 'scatter' as const,
            symbol: 'triangle',
            symbolSize: 8,
            itemStyle: { color },
            encode: { x: 0, y: 1 },
            data: overflow.map((v) => ({ value: v, symbolRotate: v[3] === -1 ? 180 : 0 })),
          };
          return [line, markers];
        }),
      );
      return { series, outside, has };
      // Keys stand in for fields, bounds, states and labels, which callers often pass as fresh literals.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [datasets, fieldsKey, valueScale, logarithmic, boundsKey, statesKey, labelsKey, detail]);
    if (!has) return <NoData text="该日志未提供这些诊断值，保留未知" />;
    return (
      <>
        <Chart
          label={label}
          height={height}
          onTimeRange={onTimeRange}
          onPoint={
            onInspect
              ? (value) => {
                  if (typeof value[0] === 'number') onInspect(value[0]);
                }
              : undefined
          }
          option={{
            animation: false,
            color: fileColors,
            textStyle: chartText,
            legend: legendStyle(states ? 84 : 64),
            tooltip: {
              ...tooltipStyle,
              trigger: 'axis',
              formatter: (params: unknown) => {
                const rows = (Array.isArray(params) ? params : [params]) as {
                  value: (number | null)[];
                  seriesName: string;
                  color: string;
                }[];
                const time = rows[0]?.value?.[0];
                const seen = new Set<string>();
                return (
                  (typeof time === 'number'
                    ? new Date(time).toISOString().replace('T', ' ').slice(0, 23) + ' UTC'
                    : '') +
                  rows
                    .filter((p) => !seen.has(p.seriesName) && !!seen.add(p.seriesName))
                    .map((p) => {
                      const raw = p.value?.[2];
                      const value = typeof raw === 'number' ? raw * (logarithmic ? 1 : valueScale) : null;
                      const note = p.value?.[3] ? '（超出阅读窗，已在边界标记）' : '';
                      const text =
                        value === null ? '—' : states ? (states[value] ?? String(value)) : Number(value.toPrecision(6));
                      return `<br/><span style="color:${escape(String(p.color))}">●</span> ${escape(p.seriesName)}：${escape(String(text))} ${escape(unit)}${note}`;
                    })
                    .join('')
                );
              },
            },
            grid: { left: states ? 84 : 64, right: 30, top: 58, bottom: 50 },
            xAxis: {
              ...timeAxisStyle,
              type: 'time',
              min: timeDomain?.start,
              max: timeDomain?.end,
              axisPointer: { show: true, label: { show: false } },
              axisLabel: { ...chartText, hideOverlap: true, formatter: utcAxisLabel },
            },
            yAxis: {
              ...valueAxisStyle(unit),
              type: logarithmic ? 'log' : 'value',
              logBase: 10,
              min: bounds?.[0],
              max: bounds?.[1],
              scale: true,
              interval: states ? 1 : undefined,
              axisLabel: {
                ...valueAxisStyle(unit).axisLabel,
                formatter: (v: number) => (states ? (states[v] ?? '') : Number(v.toPrecision(9)).toString()),
              },
            },
            dataZoom: [
              {
                id: 'time-inside',
                type: 'inside',
                xAxisIndex: 0,
                filterMode: 'none',
                zoomOnMouseWheel: 'shift',
                moveOnMouseMove: 'shift',
              },
              timeSlider(0, 5),
              {
                id: 'coordinate-0',
                type: 'inside',
                yAxisIndex: 0,
                filterMode: 'none',
                zoomOnMouseWheel: true,
                moveOnMouseMove: true,
              },
              valueSlider('coordinate-slider-0', 0, { top: 58, bottom: 50 }),
            ],
            series,
          }}
        />
        {bounds && (
          <div className="chart-note diagnostic-chart-note">
            {logarithmic
              ? 'ADOP 对数轴 0.0001–1 cycle；原值保留。'
              : bounds
                ? `阅读窗 ${bounds[0]}–${bounds[1]} ${unit}；越界点 ${outside} 个，三角标记保留原值。`
                : ''}
          </div>
        )}
      </>
    );
  },
  (a, b) =>
    a.datasets === b.datasets &&
    a.fields.join('|') === b.fields.join('|') &&
    a.label === b.label &&
    a.unit === b.unit &&
    a.valueScale === b.valueScale &&
    a.logarithmic === b.logarithmic &&
    a.onTimeRange === b.onTimeRange &&
    a.onInspect === b.onInspect &&
    a.height === b.height &&
    a.timeDomain?.start === b.timeDomain?.start &&
    a.timeDomain?.end === b.timeDomain?.end &&
    a.displayBounds?.[0] === b.displayBounds?.[0] &&
    a.displayBounds?.[1] === b.displayBounds?.[1] &&
    JSON.stringify(a.states) === JSON.stringify(b.states) &&
    JSON.stringify(a.labels) === JSON.stringify(b.labels),
);
