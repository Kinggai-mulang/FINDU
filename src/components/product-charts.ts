import type { EChartsCoreOption } from 'echarts/core';
import type { ProductComparison, ProductSatellite } from '../../contracts';
import { systemColors } from '../services/satellites';
import { systemKeys, systemNames } from '../services/product-compare';
import { fileColors } from './chart-data';
import { chartText, legendStyle, timeAxisStyle, timeSlider, tooltipStyle, valueAxisStyle } from './chart-theme';
import { utcAxisLabel } from '../time';
import { palette } from '../theme';

export type SeriesKey = 'r' | 'a' | 'c' | 'clock';
export const seriesNames: Record<SeriesKey, string> = {
  r: '径向',
  a: '切向',
  c: '法向',
  clock: '钟差（去公共偏移）',
};

const systemColor = (system: string) => systemColors[systemKeys[system]] ?? palette.textSecondary;

export type BarMetric = 'd3' | 'r' | 'a' | 'c' | 'clock' | 'sisre' | 'rMean';
/** What the per-satellite bar chart can show; every value is in centimetres. */
export const barMetrics: Record<BarMetric, { label: string; pick: (s: ProductSatellite) => number | null }> = {
  d3: { label: '三维 RMS', pick: (s) => s.d3.rms * 100 },
  r: { label: '径向 RMS', pick: (s) => s.r.rms * 100 },
  a: { label: '切向 RMS', pick: (s) => s.a.rms * 100 },
  c: { label: '法向 RMS', pick: (s) => s.c.rms * 100 },
  clock: { label: '钟差标准差', pick: (s) => (s.clock.n > 10 ? s.clock.std * 100 : null) },
  sisre: { label: 'SISRE', pick: (s) => (s.sisre === null ? null : s.sisre * 100) },
  rMean: { label: '径向平均偏差', pick: (s) => s.r.mean * 100 },
};

/**
 * One metric of every satellite, grouped by compared product. A single product is coloured by constellation, and
 * satellites flagged as orbit outliers get a ring; several products use one colour each.
 */
export function satelliteBarOption(results: ProductComparison[], metric: BarMetric = 'd3'): EChartsCoreOption {
  const { label, pick } = barMetrics[metric];
  const sats = [...new Set(results.flatMap((r) => r.satellites.map((s) => s.sat)))].sort();
  const single = results.length === 1;
  const find = (r: ProductComparison, sat: string) => r.satellites.find((s) => s.sat === sat);
  const round = (v: number | null) => (v === null ? null : Number(v.toFixed(3)));
  return {
    textStyle: chartText,
    legend: single ? undefined : legendStyle(),
    tooltip: {
      ...tooltipStyle,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const items = params as { seriesIndex: number; dataIndex: number }[];
        const sat = sats[items[0].dataIndex];
        const lines = items.flatMap((p) => {
          const r = results[p.seriesIndex];
          const s = find(r, sat);
          if (!s) return [];
          const value = pick(s);
          return [
            `<b>${single ? sat : `${r.name} · ${sat}`}</b>（${systemNames[s.system] ?? s.system}）`,
            `${label} ${value === null ? '—' : `${value.toFixed(2)} cm`}`,
            `三维 ${(s.d3.rms * 100).toFixed(2)} · 径向 ${(s.r.rms * 100).toFixed(2)} · 切向 ${(s.a.rms * 100).toFixed(2)} · 法向 ${(s.c.rms * 100).toFixed(2)} cm`,
            s.clock.n ? `钟差标准差 ${(s.clock.std * 100).toFixed(2)} cm` : '无钟差',
            s.outlier ? '<span style="color:#f27d90">异常卫星</span>' : '',
          ];
        });
        return lines.filter(Boolean).join('<br/>');
      },
    },
    grid: { left: 64, right: 24, top: single ? 40 : 56, bottom: 56 },
    xAxis: {
      type: 'category',
      data: sats,
      axisLabel: { ...chartText, rotate: 60, interval: 0, fontSize: 10 },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: { type: 'value', ...valueAxisStyle(`${label} / cm`) },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }],
    series: results.map((r, i) => ({
      name: r.name,
      type: 'bar' as const,
      barMaxWidth: single ? 18 : 12,
      // the legend takes the colour of the series, not that of the bars
      itemStyle: { color: single ? undefined : fileColors[i % fileColors.length] },
      data: sats.map((sat) => {
        const s = find(r, sat);
        const value = s ? round(pick(s)) : null;
        if (!single) return { value, itemStyle: { color: fileColors[i % fileColors.length] } };
        const ring = s?.outlier && metric === 'd3';
        return {
          value,
          itemStyle: {
            color: systemColor(s?.system ?? sat[0]),
            borderColor: ring ? palette.error : 'transparent',
            borderWidth: ring ? 2 : 0,
          },
        };
      }),
    })),
  };
}

/** One satellite's series for every compared product on the shared UTC axis; values are metres, shown in cm. */
export function seriesOption(results: ProductComparison[], sat: string, key: SeriesKey): EChartsCoreOption {
  const series = results.flatMap((result, i) => {
    const s = result.satellites.find((x) => x.sat === sat);
    if (!s) return [];
    const values = { r: s.rSeries, a: s.aSeries, c: s.cSeries, clock: s.clockSeries }[key];
    return [
      {
        name: result.name,
        type: 'line' as const,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 1.4, color: fileColors[i % fileColors.length] },
        itemStyle: { color: fileColors[i % fileColors.length] },
        data: result.epochs.map((t, k) => [t, values[k] === null ? null : Number((values[k]! * 100).toFixed(3))]),
      },
    ];
  });
  return {
    textStyle: chartText,
    legend: legendStyle(),
    tooltip: { ...tooltipStyle, trigger: 'axis' },
    grid: { left: 64, right: 24, top: 52, bottom: 64 },
    xAxis: { type: 'time', axisLabel: { ...chartText, formatter: utcAxisLabel }, ...timeAxisStyle },
    yAxis: { type: 'value', scale: true, ...valueAxisStyle(`${sat} ${seriesNames[key]} / cm`) },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }, timeSlider(0)],
    series,
  };
}

/** Orbit 3D RMS per GPST hour and constellation; every compared product is one line style per constellation. */
export function hourlyOption(results: ProductComparison[]): EChartsCoreOption {
  const series = results.flatMap((result, i) => {
    const systems = [...new Set(result.hourly.map((h) => h.system))];
    return systems.map((system) => ({
      name: results.length > 1 ? `${result.name} · ${systemNames[system] ?? system}` : (systemNames[system] ?? system),
      type: 'line' as const,
      showSymbol: true,
      symbolSize: 4,
      lineStyle: { width: 1.6, color: systemColor(system), type: i === 0 ? ('solid' as const) : ('dashed' as const) },
      itemStyle: { color: systemColor(system) },
      data: result.hourly.filter((h) => h.system === system).map((h) => [h.time, Number((h.d3Rms * 100).toFixed(3))]),
    }));
  });
  return {
    textStyle: chartText,
    legend: legendStyle(),
    tooltip: { ...tooltipStyle, trigger: 'axis' },
    grid: { left: 64, right: 24, top: 52, bottom: 40 },
    xAxis: { type: 'time', axisLabel: { ...chartText, formatter: utcAxisLabel }, ...timeAxisStyle },
    yAxis: { type: 'value', scale: true, ...valueAxisStyle('轨道三维 RMS / cm') },
    series,
  };
}
