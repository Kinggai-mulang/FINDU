import type { EChartsCoreOption } from 'echarts/core';
import type { BiasComparison, BiasItem } from '../../contracts';
import { systemColors } from '../services/satellites';
import { systemKeys, systemNames } from '../services/product-compare';
import { fileColors } from './chart-data';
import { epochLabel, isCyclic } from '../services/bias-compare';
import { chartText, legendStyle, timeSlider, tooltipStyle, valueAxisStyle } from './chart-theme';
import { palette } from '../theme';

const systemColor = (system: string) => systemColors[systemKeys[system]] ?? palette.textSecondary;

/** Signals that exist in the comparison, in table order, as `signal` strings with their kind. */
export function signalList(results: BiasComparison[]) {
  const seen = new Map<string, { signal: string; kind: BiasItem['kind']; system: string }>();
  for (const r of results)
    for (const row of r.rows) {
      const key = `${row.system}|${row.signal}`;
      if (!seen.has(key)) seen.set(key, { signal: row.signal, kind: row.kind, system: row.system });
    }
  return [...seen.entries()].map(([key, v]) => ({ key, ...v }));
}

/** Difference to the reference of one signal for every satellite, grouped by compared product. */
export function biasBarOption(results: BiasComparison[], system: string, signal: string): EChartsCoreOption {
  const items = results.map((r) => r.items.filter((i) => i.system === system && i.signal === signal));
  const sats = [...new Set(items.flatMap((list) => list.map((i) => i.sat)))].sort();
  const sample = items.flat()[0];
  const unit = sample && isCyclic(sample.kind) ? '周' : 'ns';
  // a narrow-lane has no difference worth plotting (its constant is arbitrary): its scatter in the day is the figure
  const scatter = sample?.kind === 'nl' || sample?.kind === 'nlc';
  const figure = (item: BiasItem) => (scatter ? item.rms : item.mean);
  const single = results.length === 1;
  const round = (v: number) => Number(v.toFixed(4));
  return {
    textStyle: chartText,
    legend: single ? undefined : legendStyle(),
    tooltip: {
      ...tooltipStyle,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const hit = params as { seriesIndex: number; dataIndex: number }[];
        const sat = sats[hit[0].dataIndex];
        return hit
          .flatMap((p) => {
            const item = items[p.seriesIndex].find((i) => i.sat === sat);
            if (!item) return [];
            return [
              `<b>${single ? sat : `${results[p.seriesIndex].name} · ${sat}`}</b>（${systemNames[item.system] ?? item.system}）`,
              scatter
                ? `${signal} 日内波动 ${item.rms.toFixed(3)} ${unit}，已去掉的常数 ${item.mean.toFixed(3)} ${unit}`
                : `${signal} 差 ${item.mean >= 0 ? '+' : ''}${item.mean.toFixed(3)} ${unit}，RMS ${item.rms.toFixed(3)} ${unit}`,
              scatter ? `${item.n} 个历元` : `日内标准差 ${item.temporalStd.toFixed(3)} ${unit} · ${item.n} 个历元`,
              item.outlier ? '<span style="color:#f27d90">异常</span>' : '',
            ];
          })
          .filter(Boolean)
          .join('<br/>');
      },
    },
    grid: { left: 64, right: 24, top: single ? 40 : 56, bottom: 56 },
    xAxis: {
      type: 'category',
      data: sats,
      axisLabel: { ...chartText, rotate: 60, interval: 0, fontSize: 10 },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: { type: 'value', ...valueAxisStyle(`${signal} ${scatter ? '日内波动' : '差'} / ${unit}`) },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }],
    series: results.map((r, k) => ({
      name: r.name,
      type: 'bar' as const,
      barMaxWidth: single ? 18 : 12,
      // the legend takes the colour of the series, not that of the bars
      itemStyle: { color: single ? undefined : fileColors[k % fileColors.length] },
      data: sats.map((sat) => {
        const item = items[k].find((i) => i.sat === sat);
        if (!item) return { value: null, itemStyle: {} };
        if (!single) return { value: round(figure(item)), itemStyle: { color: fileColors[k % fileColors.length] } };
        return {
          value: round(figure(item)),
          itemStyle: {
            color: systemColor(item.system),
            borderColor: item.outlier ? palette.error : 'transparent',
            borderWidth: item.outlier ? 2 : 0,
          },
        };
      }),
    })),
  };
}

const round = (v: number, digits = 4) => Number(v.toFixed(digits));
const unitName = (cyclic: boolean) => (cyclic ? '周' : 'ns');
const rowOf = (result: BiasComparison, system: string, signal: string) =>
  result.rows.find((r) => r.system === system && r.signal === signal);

/** Title shared by the cards and charts of one signal, e.g. `GPS · WL L1C-L2W`. */
export const signalTitle = (system: string, signal: string) => `${systemNames[system] ?? system} · ${signal}`;

/**
 * Distribution of the difference to the reference over all satellites and epochs, one outline per product, as a share
 * of the samples so products of different length compare. Cyclic quantities mark the ±0.1 cycle ambiguity limit.
 */
export function histogramOption(results: BiasComparison[], system: string, signal: string): EChartsCoreOption {
  const rows = results.map((r) => rowOf(r, system, signal));
  const sample = rows.find(Boolean);
  if (!sample) return {};
  const cyclic = sample.unit === 'cyc';
  const unit = unitName(cyclic);
  const single = results.length === 1;
  const { min, width } = sample.histogram;
  const limit = Math.abs(min);
  return {
    textStyle: chartText,
    legend: single ? undefined : legendStyle(44),
    tooltip: {
      ...tooltipStyle,
      trigger: 'axis',
      formatter: (params: unknown) => {
        const hit = params as { seriesName: string; value: [number, number] }[];
        if (!hit.length) return '';
        const x = hit[0].value[0];
        return [
          `<b>${(x - width / 2).toFixed(3)} ~ ${(x + width / 2).toFixed(3)} ${unit}</b>`,
          ...hit.map((p) => `${p.seriesName}：${p.value[1].toFixed(2)}%`),
        ].join('<br/>');
      },
    },
    grid: { left: 48, right: 16, top: single ? 30 : 52, bottom: 36 },
    xAxis: {
      type: 'value',
      min: -limit,
      max: limit,
      name: `差 / ${unit}`,
      nameLocation: 'middle',
      nameGap: 24,
      nameTextStyle: { color: palette.axisName, fontSize: 12 },
      axisLabel: { ...chartText, hideOverlap: true },
      axisLine: { lineStyle: { color: palette.axisLine } },
      splitLine: { show: false },
    },
    yAxis: { type: 'value', min: 0, ...valueAxisStyle('占比 / %') },
    series: results.flatMap((r, k) => {
      const row = rows[k];
      if (!row) return [];
      const h = row.histogram;
      const total = h.counts.reduce((a, b) => a + b, 0) || 1;
      const color = single ? systemColor(system) : fileColors[k % fileColors.length];
      return [
        {
          name: r.name,
          type: 'line' as const,
          step: 'middle' as const,
          symbol: 'none',
          data: h.counts.map((count, i) => [round(h.min + (i + 0.5) * h.width), round((count / total) * 100, 3)]),
          lineStyle: { width: 1.6, color },
          itemStyle: { color },
          areaStyle: { color, opacity: single ? 0.3 : 0.14 },
          markLine:
            cyclic && k === 0
              ? {
                  silent: true,
                  symbol: 'none',
                  label: { show: false },
                  lineStyle: { color: palette.warning, type: 'dashed' as const, width: 1 },
                  data: [{ xAxis: -0.1 }, { xAxis: 0.1 }],
                }
              : undefined,
        },
      ];
    }),
  };
}

/** Signals of the kind, system by system. */
const kindRows = (results: BiasComparison[], kind: BiasItem['kind']) => {
  const keys = new Map<string, { system: string; signal: string }>();
  for (const r of results)
    for (const row of r.rows) if (row.kind === kind) keys.set(`${row.system}|${row.signal}`, row);
  return [...keys.values()];
};

export const rmsBarHeight = (results: BiasComparison[], kind: BiasItem['kind']) =>
  Math.max(150, kindRows(results, kind).length * Math.max(24, 13 * results.length + 8) + 56);

/** Total RMS (every satellite and epoch) of each signal of one kind, one bar per product. */
export function rmsBarOption(results: BiasComparison[], kind: BiasItem['kind']): EChartsCoreOption {
  const rows = kindRows(results, kind);
  const labels = rows.map((r) => signalTitle(r.system, r.signal));
  const unit = unitName(isCyclic(kind));
  const single = results.length === 1;
  return {
    textStyle: chartText,
    legend: single ? undefined : legendStyle(8),
    tooltip: {
      ...tooltipStyle,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const hit = params as { seriesIndex: number; dataIndex: number }[];
        if (!hit.length) return '';
        const { system, signal } = rows[hit[0].dataIndex];
        return [
          `<b>${signalTitle(system, signal)}</b>`,
          ...hit.flatMap((p) => {
            const row = rowOf(results[p.seriesIndex], system, signal);
            if (!row) return [];
            const within = row.epochWithin === null ? '' : ` · ±0.1 周内 ${(row.epochWithin * 100).toFixed(0)}%`;
            return [
              `${single ? '' : `${results[p.seriesIndex].name}：`}RMS ${row.totalRms.toFixed(3)} ${unit}${within}`,
              `卫星平均差 RMS ${row.rms.toFixed(3)} · 最大 ${row.max.toFixed(3)} · 异常 ${row.outliers} 颗`,
            ];
          }),
        ].join('<br/>');
      },
    },
    grid: { left: 150, right: 56, top: single ? 8 : 34, bottom: 28 },
    xAxis: { type: 'value', ...valueAxisStyle(`RMS / ${unit}`), nameLocation: 'middle', nameGap: 22 },
    yAxis: {
      type: 'category',
      inverse: true,
      data: labels,
      axisLabel: { ...chartText, fontSize: 11 },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    series: results.map((r, k) => ({
      name: r.name,
      type: 'bar' as const,
      barMaxWidth: 16,
      itemStyle: { color: single ? undefined : fileColors[k % fileColors.length] },
      label: { show: true, position: 'right' as const, color: palette.axisLabel, fontSize: 11 },
      data: rows.map((row) => {
        const found = rowOf(r, row.system, row.signal);
        return found
          ? { value: round(found.totalRms, 3), itemStyle: single ? { color: systemColor(row.system) } : {} }
          : { value: null };
      }),
    })),
  };
}

const epochLabels = (result: BiasComparison) => Array.from({ length: result.epochs }, (_, k) => epochLabel(result, k));

/** The RMS over satellites at each epoch, or the removed datum, for one signal; shows when a product degrades. */
export function epochSeriesOption(
  results: BiasComparison[],
  system: string,
  signal: string,
  field: 'rms' | 'datum',
): EChartsCoreOption {
  const base = results.find((r) => rowOf(r, system, signal));
  const sample = base && rowOf(base, system, signal);
  if (!base || !sample) return {};
  const unit = unitName(sample.unit === 'cyc');
  const single = results.length === 1;
  return {
    textStyle: chartText,
    legend: single ? undefined : legendStyle(56),
    tooltip: { ...tooltipStyle, trigger: 'axis' },
    grid: { left: 56, right: 20, top: single ? 34 : 54, bottom: 52 },
    xAxis: {
      type: 'category',
      data: epochLabels(base),
      boundaryGap: false,
      axisLabel: { ...chartText, hideOverlap: true },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    yAxis: { type: 'value', scale: true, ...valueAxisStyle(`${field === 'rms' ? 'RMS' : '扣除的基准'} / ${unit}`) },
    dataZoom: [{ type: 'inside', xAxisIndex: 0 }, timeSlider(0)],
    series: results.flatMap((r, k) => {
      const row = rowOf(r, system, signal);
      if (!row || row.series[field].length !== base.epochs) return [];
      const color = single ? systemColor(system) : fileColors[k % fileColors.length];
      return [
        {
          name: r.name,
          type: 'line' as const,
          showSymbol: false,
          connectNulls: false,
          lineStyle: { width: 1.3, color },
          itemStyle: { color },
          data: row.series[field],
        },
      ];
    }),
  };
}

export const heatmapHeight = (satellites: number) => Math.max(200, satellites * 13 + 110);

/** Residual of every satellite over the day, banded by the ambiguity limits; the quiet band is "within ±0.1 cycles". */
export function heatmapOption(result: BiasComparison, system: string, signal: string): EChartsCoreOption {
  const items = result.items.filter((i) => i.system === system && i.signal === signal && i.series);
  const sats = items.map((i) => i.sat).sort();
  const data: [number, number, number][] = [];
  for (const item of items) {
    const y = sats.indexOf(item.sat);
    item.series?.forEach((v, k) => {
      if (v !== null) data.push([k, y, v]);
    });
  }
  const labels = epochLabels(result);
  return {
    textStyle: chartText,
    tooltip: {
      ...tooltipStyle,
      formatter: (p: unknown) => {
        const [k, y, v] = (p as { value: [number, number, number] }).value;
        return `<b>${sats[y]}</b> · ${labels[k]}<br/>${v >= 0 ? '+' : ''}${v.toFixed(3)} 周`;
      },
    },
    grid: { left: 48, right: 16, top: 8, bottom: 78 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { ...chartText, hideOverlap: true },
      axisLine: { lineStyle: { color: palette.axisLine } },
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category',
      data: sats,
      inverse: true,
      axisLabel: { ...chartText, fontSize: 10, interval: 0 },
      axisLine: { lineStyle: { color: palette.axisLine } },
    },
    visualMap: {
      type: 'piecewise',
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 14,
      itemHeight: 10,
      textStyle: { color: palette.legendText, fontSize: 11 },
      dimension: 2,
      pieces: [
        { min: -0.5, max: -0.25, label: '< -0.25', color: '#4f7fd9' },
        { min: -0.25, max: -0.1, label: '-0.25 ~ -0.1', color: '#34588f' },
        { min: -0.1, max: 0.1, label: '±0.1 周内', color: '#223244' },
        { min: 0.1, max: 0.25, label: '0.1 ~ 0.25', color: palette.warning },
        { min: 0.25, max: 0.5, label: '> 0.25', color: palette.error },
      ],
    },
    series: [{ type: 'heatmap' as const, data, progressive: 0, itemStyle: { borderWidth: 0 } }],
  };
}
