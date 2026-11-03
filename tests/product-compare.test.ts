import { describe, expect, it } from 'vitest';
import type { ProductComparison, ProductSatellite } from '../contracts';
import { hourlyOption, satelliteBarOption, seriesOption } from '../src/components/product-charts';
import { assignStreamFiles, convertLevel, validStartTime } from '../src/components/StreamConverter';
import { cm, comparisonCsv } from '../src/services/product-compare';

const moments = (rms: number, mean = 0) => ({ mean, rms, std: rms, max: rms * 2, n: 3 });
const sat = (id: string, d3: number, extra: Partial<ProductSatellite> = {}): ProductSatellite => ({
  sat: id,
  system: id[0],
  r: moments(d3 / 3),
  a: moments(d3 / 2),
  c: moments(d3 / 3),
  d3: moments(d3),
  clock: moments(0.02),
  clockJumps: 0,
  sisre: 0.03,
  coverage: 1,
  outlier: false,
  rSeries: [0.01, null, 0.03],
  aSeries: [0, 0, 0],
  cSeries: [0, 0, 0],
  clockSeries: [0.1, 0.2, null],
  ...extra,
});
const result = (name: string, satellites: ProductSatellite[]): ProductComparison => ({
  name,
  timeSystem: 'GPS',
  epochs: [1_000, 301_000, 601_000],
  stepSeconds: 300,
  systems: [],
  satellites,
  apc: false,
  candidates: satellites.map((s) => s.sat),
  excluded: [],
  orbitClasses: {},
  hourly: [
    { system: 'G', time: 0, d3Rms: 0.03 },
    { system: 'C', time: 0, d3Rms: 0.05 },
  ],
  hints: [],
  testOnly: [],
  referenceOnly: [],
});

describe('product numbers', () => {
  it('formats distances in centimetres and tolerates missing numbers', () => {
    expect(cm(0.0331)).toBe('3.3');
    expect(cm(0.0331, 2)).toBe('3.31');
    expect(cm(null)).toBe('—');
    expect(cm(Number.NaN)).toBe('—');
  });
});

describe('comparison export and charts', () => {
  const results = [result('WHU 实时', [sat('G01', 0.03), sat('C07', 0.16, { outlier: true, clockJumps: 2 })])];
  it('writes one CSV row per satellite with the outlier flag', () => {
    const lines = comparisonCsv(results).trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('三维RMS cm');
    expect(lines[1].split(',')[1]).toBe('G01');
    expect(lines[2]).toContain('16.00');
    expect(lines[2].endsWith('是')).toBe(true);
  });
  it('builds a coloured, sorted satellite bar chart and marks outliers', () => {
    const option = satelliteBarOption(results, 'd3') as {
      xAxis: { data: string[] };
      series: { data: { value: number; itemStyle: { borderWidth: number } }[] }[];
    };
    expect(option.xAxis.data).toEqual(['C07', 'G01']);
    expect(option.series[0].data.map((d) => d.value)).toEqual([16, 3]);
    expect(option.series[0].data[0].itemStyle.borderWidth).toBe(2);
  });
  it('switches the bar metric: radial, along, cross, clock, SISRE and the signed radial mean', () => {
    const value = (metric: Parameters<typeof satelliteBarOption>[1]) =>
      (satelliteBarOption(results, metric) as { series: { data: { value: number | null }[] }[] }).series[0].data.map(
        (d) => d.value,
      );
    expect(value('r')).toEqual([5.333, 1]);
    expect(value('a')).toEqual([8, 1.5]);
    expect(value('c')).toEqual([5.333, 1]);
    expect(value('sisre')).toEqual([3, 3]);
    expect(value('rMean')).toEqual([0, 0]);
    // fewer than 11 clock epochs: the clock bar is left empty instead of drawing a meaningless value
    expect(value('clock')).toEqual([null, null]);
    const long = result('long', [sat('G01', 0.03, { clock: { ...moments(0.02), n: 40, std: 0.018 } })]);
    expect(
      (satelliteBarOption([long], 'clock') as { series: { data: { value: number }[] }[] }).series[0].data[0].value,
    ).toBe(1.8);
  });
  it('groups several products side by side, one colour each, and fills missing satellites with gaps', () => {
    const two = [...results, result('CHC 实时', [sat('G01', 0.05)])];
    const option = satelliteBarOption(two, 'a') as {
      series: { name: string; data: { value: number | null; itemStyle: { color: string } }[] }[];
    };
    expect(option.series.map((s) => s.name)).toEqual(['WHU 实时', 'CHC 实时']);
    expect(option.series[1].data.map((d) => d.value)).toEqual([null, 2.5]);
    expect(option.series[0].data[0].itemStyle.color).not.toBe(option.series[1].data[1].itemStyle.color);
  });
  it('keeps gaps in the series and puts every product on the same axis', () => {
    const two = [...results, result('CHC 实时', [sat('G01', 0.05)])];
    const option = seriesOption(two, 'G01', 'r') as { series: { name: string; data: (number | null)[][] }[] };
    expect(option.series.map((s) => s.name)).toEqual(['WHU 实时', 'CHC 实时']);
    expect(option.series[0].data).toEqual([
      [1_000, 1],
      [301_000, null],
      [601_000, 3],
    ]);
    expect((seriesOption(two, 'E99', 'r') as { series: unknown[] }).series).toEqual([]);
  });
  it('draws one hourly line per constellation', () => {
    const option = hourlyOption(results) as { series: { name: string }[] };
    expect(option.series.map((s) => s.name).sort()).toEqual(['GPS', '北斗']);
  });
});

describe('stream conversion input', () => {
  it('accepts an empty or complete UTC start time only', () => {
    expect(validStartTime('')).toBe(true);
    expect(validStartTime('  ')).toBe(true);
    expect(validStartTime('2026-10-18 09:58:00')).toBe(true);
    expect(validStartTime(' 2026-10-18 09:58:00 ')).toBe(true);
    expect(validStartTime('2026-10-18')).toBe(false);
    expect(validStartTime('18.10.2026 09:58:00')).toBe(false);
  });
});

describe('recorded files dropped on the converter', () => {
  const names = [
    'D:\\rec\\PROD_SSRC00WHU0_20260919T1734-20260920T0517.rtcm3',
    'D:\\rec\\BIAS_OSBC00WHU1_20260919T1734-20260920T0517.rtcm3',
    'D:\\rec\\BRDC_20260919-20_IGS.rnx',
  ];
  it('sorts a set of recordings into the inputs by name', () => {
    expect(assignStreamFiles(names, true)).toEqual({ ssr: names[0], osb: names[1], navi: names[2], unknown: [] });
  });
  it('knows that a stream called BIAS_EPH2IGS carries ephemerides', () => {
    const eph = 'D:/rec/BIAS_EPH2IGS_20261018T0958-20261019T1232.rtcm3';
    expect(assignStreamFiles([eph, 'D:/rec/PROD_SSRC00CHC1_20261018T0958-20261019T1232.rtcm3'], true)).toEqual({
      navi: eph,
      ssr: 'D:/rec/PROD_SSRC00CHC1_20261018T0958-20261019T1232.rtcm3',
      unknown: [],
    });
  });
  it('leaves the bias stream out of an orbit conversion and reports what it cannot place', () => {
    const found = assignStreamFiles([names[0], names[1], 'D:/rec/notes.txt', 'x/y.15n'], false);
    expect(found.ssr).toBe(names[0]);
    expect(found.osb).toBeUndefined();
    expect(found.navi).toBe('x/y.15n');
    expect(found.unknown).toEqual([names[1], 'D:/rec/notes.txt']);
  });
  it('keeps the first of several files for one input', () => {
    expect(assignStreamFiles(['a/PROD_1.rtcm3', 'a/PROD_2.rtcm3'], true).ssr).toBe('a/PROD_1.rtcm3');
  });
});

describe('HAS and B2b recordings', () => {
  it('sorts a HAS recording with its ephemerides and a B2b log with the receiver log beside it', () => {
    expect(assignStreamFiles(['D:/d/HAS.has', 'D:/d/COMMON_ROVE.rtcm3'], false)).toEqual({
      ssr: 'D:/d/HAS.has',
      navi: 'D:/d/COMMON_ROVE.rtcm3',
      unknown: [],
    });
    const b2b = assignStreamFiles(
      ['D:/d/ROVE_HX10_20261012T1321-20261013T0212.oem', 'D:/d/PROD_WHU-HX10_20261012T1321-20261013T0212.oem'],
      true,
    );
    expect(b2b.ssr).toContain('PROD_WHU-HX10');
    expect(b2b.navi).toContain('ROVE_HX10');
    expect(b2b.unknown).toEqual([]);
  });
  it('asks for the capability level each conversion needs', () => {
    expect(convertLevel('orbit', 'ssr')).toBe(1);
    expect(convertLevel('bias', 'ssr')).toBe(2);
    expect(convertLevel('orbit', 'has')).toBe(3);
    expect(convertLevel('bias', 'b2b')).toBe(3);
  });
});

describe('product chart colours', () => {
  it('colours the legend entry of each product like its bars', () => {
    const results = [result('A', [sat('G01', 0.03)]), result('B', [sat('G01', 0.04)])];
    const option = satelliteBarOption(results, 'd3') as {
      series: { itemStyle: { color: string }; data: { itemStyle: { color: string } }[] }[];
    };
    for (const s of option.series) expect(s.itemStyle.color).toBe(s.data[0].itemStyle.color);
    expect(option.series[0].itemStyle.color).not.toBe(option.series[1].itemStyle.color);
  });
});
