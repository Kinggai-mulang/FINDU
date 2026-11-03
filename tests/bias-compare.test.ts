import { describe, expect, it } from 'vitest';
import type { BiasComparison, BiasItem, BiasRow } from '../contracts';
import {
  biasBarOption,
  epochSeriesOption,
  heatmapOption,
  histogramOption,
  rmsBarOption,
  signalList,
} from '../src/components/bias-charts';
import { biasCsv, epochLabel, fixed, isCyclic, kindOrder, signText } from '../src/services/bias-compare';

const item = (sat: string, signal: string, mean: number, extra: Partial<BiasItem> = {}): BiasItem => ({
  sat,
  system: sat[0],
  signal,
  kind: signal.startsWith('L') || signal.startsWith('WL') ? 'phase' : 'code',
  mean,
  rms: Math.abs(mean) + 0.01,
  temporalStd: 0.002,
  n: 288,
  outlier: false,
  ...extra,
});
const row = (system: string, signal: string, extra: Partial<BiasRow> = {}): BiasRow => ({
  system,
  signal,
  kind: 'code',
  unit: 'ns',
  sats: 30,
  offset: 0.05,
  rms: 0.3,
  max: 0.8,
  temporalStd: 0,
  withinTolerance: null,
  outliers: 1,
  totalRms: 0.35,
  epochWithin: null,
  histogram: {
    min: -0.5,
    width: 0.02,
    counts: Array.from({ length: 50 }, (_, i) => (i === 25 ? 80 : i === 24 ? 20 : 0)),
  },
  series: { rms: [0.2, 0.3, null], datum: [0.1, 0.1, 0.12] },
  ...extra,
});
const result = (name: string, items: BiasItem[], rows: BiasRow[]): BiasComparison => ({
  name,
  timeSystem: 'G',
  start: '2026-09-19T17:35:00',
  step: 300,
  epochs: 3,
  satellites: [...new Set(items.map((i) => i.sat))].sort(),
  excluded: [],
  sign: { code: 1, phase: 1, auto: true, correlation: 0.99 },
  orbitClasses: {},
  rows,
  items,
  hints: [],
  testOnly: [],
  referenceOnly: [],
});

describe('bias numbers', () => {
  it('formats numbers with a dash for missing values', () => {
    expect(fixed(0.12345, 'ns')).toBe('0.123');
    expect(fixed(null, 'cyc')).toBe('—');
    expect(fixed(Number.NaN, 'ns')).toBe('—');
  });
});

describe('bias export and charts', () => {
  const items = [
    item('G01', 'C1W', 0.12),
    item('G02', 'C1W', -2.4, { outlier: true }),
    item('G01', 'L1W', 0.3),
    item('E01', 'C1C', 0.01),
  ];
  const rows = [row('G', 'C1W'), row('G', 'L1W', { kind: 'phase', unit: 'cyc' }), row('E', 'C1C')];
  const results = [result('WHU 实时', items, rows)];
  it('writes one CSV line per satellite item with units and the outlier flag', () => {
    const lines = biasCsv(results).trim().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[2]).toContain('-2.40000');
    expect(lines[2].endsWith(',是,ns')).toBe(true);
    expect(lines[3].endsWith(',,周')).toBe(true);
  });
  it('lists every signal once with its kind, in table order', () => {
    const list = signalList([...results, result('CHC', [], [row('G', 'C1W'), row('E', 'C5Q')])]);
    expect(list.map((s) => s.key)).toEqual(['G|C1W', 'G|L1W', 'E|C1C', 'E|C5Q']);
    expect(list[1].kind).toBe('phase');
  });
  it('draws a signed bar per satellite with a ring on outliers', () => {
    const option = biasBarOption(results, 'G', 'C1W') as {
      xAxis: { data: string[] };
      series: { data: { value: number; itemStyle: { borderWidth: number } }[] }[];
    };
    expect(option.xAxis.data).toEqual(['G01', 'G02']);
    expect(option.series[0].data.map((d) => d.value)).toEqual([0.12, -2.4]);
    expect(option.series[0].data[1].itemStyle.borderWidth).toBe(2);
  });
  it('groups products side by side and leaves gaps for satellites a product does not have', () => {
    const two = [...results, result('CHC', [item('G01', 'C1W', 0.2)], [row('G', 'C1W')])];
    const option = biasBarOption(two, 'G', 'C1W') as { series: { name: string; data: { value: number | null }[] }[] };
    expect(option.series.map((s) => s.name)).toEqual(['WHU 实时', 'CHC']);
    expect(option.series[1].data.map((d) => d.value)).toEqual([0.2, null]);
  });
  it('uses cycles on the axis for phase signals', () => {
    const option = biasBarOption(results, 'G', 'L1W') as { yAxis: { name: string } };
    expect(option.yAxis.name).toContain('周');
  });
});

describe('ambiguity charts', () => {
  const wl = row('G', 'WL L1C-L2W', { kind: 'wl', unit: 'cyc', epochWithin: 0.97, totalRms: 0.04 });
  const nl = row('G', 'NL L1C', { kind: 'nl', unit: 'cyc', epochWithin: 0.8, totalRms: 0.12 });
  const withSeries = (sat: string, kind: BiasItem['kind'], signal: string, series: (number | null)[]) =>
    item(sat, signal, 0, { kind, series });
  const one = result(
    'WHU 实时',
    [
      withSeries('G01', 'wl', 'WL L1C-L2W', [0.02, null, -0.3]),
      withSeries('G02', 'wl', 'WL L1C-L2W', [0.05, 0.04, 0.2]),
    ],
    [wl, nl, row('G', 'C1W')],
  );
  it('labels grid epochs with the date and time of the products', () => {
    expect(epochLabel(one, 0)).toBe('09-19 17:35');
    expect(epochLabel(one, 13)).toBe('09-19 18:40');
    expect(epochLabel({ start: '2026-09-19T23:55:00', step: 300 }, 1)).toBe('09-20 00:00');
  });
  it('draws the distribution as a share of the samples and marks the ambiguity limit', () => {
    const option = histogramOption([one], 'G', 'WL L1C-L2W') as {
      series: { data: [number, number][]; markLine?: { data: { xAxis: number }[] } }[];
      xAxis: { min: number; max: number };
    };
    const data = option.series[0].data;
    expect(data).toHaveLength(50);
    expect(data.reduce((a, d) => a + d[1], 0)).toBeCloseTo(100, 2);
    expect(data[25][0]).toBeCloseTo(0.01, 6);
    expect(data[25][1]).toBeCloseTo(80, 6);
    expect([option.xAxis.min, option.xAxis.max]).toEqual([-0.5, 0.5]);
    expect(option.series[0].markLine?.data.map((d) => d.xAxis)).toEqual([-0.1, 0.1]);
    expect(
      (histogramOption([one], 'G', 'C1W') as { series: { markLine?: unknown }[] }).series[0].markLine,
    ).toBeUndefined();
    expect(histogramOption([one], 'E', 'C1C')).toEqual({});
  });
  it('lists one bar per signal of the kind with a gap where a product lacks it', () => {
    const other = result('CHC', [], [row('G', 'NL L1C', { kind: 'nl', unit: 'cyc', totalRms: 0.2 })]);
    const option = rmsBarOption([one, other], 'nl') as {
      yAxis: { data: string[] };
      series: { name: string; data: { value: number | null }[] }[];
    };
    expect(option.yAxis.data).toEqual(['GPS · NL L1C']);
    expect(option.series.map((s) => s.data[0].value)).toEqual([0.12, 0.2]);
    const wide = rmsBarOption([one, other], 'wl') as { series: { data: { value: number | null }[] }[] };
    expect(wide.series[1].data[0].value).toBeNull();
  });
  it('draws the residual of every satellite and epoch as heat map cells, skipping missing ones', () => {
    const option = heatmapOption(one, 'G', 'WL L1C-L2W') as {
      yAxis: { data: string[] };
      xAxis: { data: string[] };
      series: { data: [number, number, number][] }[];
    };
    expect(option.yAxis.data).toEqual(['G01', 'G02']);
    expect(option.xAxis.data).toHaveLength(3);
    expect(option.series[0].data).toEqual([
      [0, 0, 0.02],
      [2, 0, -0.3],
      [0, 1, 0.05],
      [1, 1, 0.04],
      [2, 1, 0.2],
    ]);
  });
  it('plots the per-epoch RMS and the removed datum per product', () => {
    const rms = epochSeriesOption([one], 'G', 'NL L1C', 'rms') as { series: { data: (number | null)[] }[] };
    expect(rms.series[0].data).toEqual([0.2, 0.3, null]);
    const datum = epochSeriesOption([one], 'G', 'NL L1C', 'datum') as { series: { data: number[] }[] };
    expect(datum.series[0].data).toEqual([0.1, 0.1, 0.12]);
    expect(epochSeriesOption([one], 'E', 'C1C', 'rms')).toEqual({});
  });
});

describe('narrow-lane with clock', () => {
  it('is cyclic, listed right after the wide-lane and counted in the CSV as cycles', () => {
    expect(isCyclic('nlc')).toBe(true);
    expect(kindOrder).toEqual(['wl', 'nlc', 'nl', 'code', 'codec', 'dcb', 'phase']);
    expect(isCyclic('codec')).toBe(false);
    const csv = biasCsv([result('x', [item('G01', 'NL+CLK L1C', 0.1, { kind: 'nlc' })], [])]);
    expect(csv.trim().split('\r\n')[1].endsWith(',周')).toBe(true);
  });
});

describe('sign convention and scatter charts', () => {
  it('says what was inverted and whether the data decided it', () => {
    expect(signText(undefined)).toBe('');
    expect(signText({ code: 1, phase: 1, auto: true, correlation: 0.9 })).toBe('');
    expect(signText({ code: -1, phase: -1, auto: true, correlation: -0.96 })).toBe('码和相位偏差已取反（自动判断）');
    expect(signText({ code: -1, phase: -1, auto: false, correlation: null })).toBe('码和相位偏差已取反');
    expect(signText({ code: 1, phase: -1, auto: true, correlation: 0.8 })).toBe('相位偏差已取反（自动判断）');
    expect(signText({ code: -1, phase: 1, auto: false, correlation: null })).toBe('码偏差已取反');
  });
  it('plots the scatter in the day for a narrow-lane, whose constant is arbitrary, and the difference for the rest', () => {
    const items = [
      item('G01', 'NL L1C', 0.31, { kind: 'nl', rms: 0.05 }),
      item('G01', 'C1W', 0.12, { kind: 'code', rms: 0.2 }),
    ];
    const results = [result('x', items, [row('G', 'NL L1C', { kind: 'nl', unit: 'cyc' }), row('G', 'C1W')])];
    const nl = biasBarOption(results, 'G', 'NL L1C') as {
      series: { data: { value: number }[] }[];
      yAxis: { name: string };
    };
    expect(nl.series[0].data[0].value).toBe(0.05);
    expect(nl.yAxis.name).toContain('日内波动');
    const code = biasBarOption(results, 'G', 'C1W') as {
      series: { data: { value: number }[] }[];
      yAxis: { name: string };
    };
    expect(code.series[0].data[0].value).toBe(0.12);
    expect(code.yAxis.name).not.toContain('日内波动');
  });
});

describe('bias chart colours', () => {
  it('colours the legend entry of each product like its bars', () => {
    const results = [
      result('A', [item('G01', 'C1W', 0.1)], [row('G', 'C1W')]),
      result('B', [item('G01', 'C1W', 0.2)], [row('G', 'C1W')]),
    ];
    const option = biasBarOption(results, 'G', 'C1W') as {
      series: { itemStyle: { color: string }; data: { itemStyle: { color: string } }[] }[];
    };
    for (const s of option.series) expect(s.itemStyle.color).toBe(s.data[0].itemStyle.color);
    expect(option.series[0].itemStyle.color).not.toBe(option.series[1].itemStyle.color);
  });
});
