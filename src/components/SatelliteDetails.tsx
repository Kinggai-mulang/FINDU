import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Alert, Select, Space, Tag } from 'antd';
import * as echarts from 'echarts/core';
import { BarChart, ScatterChart } from 'echarts/charts';
import { GridComponent, PolarComponent, TooltipComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsCoreOption } from 'echarts/core';
import {
  satelliteCounts,
  systemColors,
  systemInk,
  systemNames,
  systemFlags,
  type SatelliteSnapshot,
} from '../services/satellites';

import '../diagnostics.css';

echarts.use([
  BarChart,
  ScatterChart,
  GridComponent,
  PolarComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

// Keep the PRN and marker in one symbol so nearby satellites cannot mix labels and colours.
const axis = {
  axisLabel: { color: '#9EADC3', fontSize: 12 },
  axisLine: { show: false },
  axisTick: { show: false },
  splitLine: { lineStyle: { color: '#FFFFFF0D' } },
};
function satelliteSymbol(prn: string, system: string, used: boolean | null) {
  const color = systemColors[system];
  const fill = used ? color : '#152133';
  const ink = used ? systemInk[system] : color;
  const shape = used === null ? '<path d="M18 1.5L34.5 18L18 34.5L1.5 18Z"/>' : '<circle cx="18" cy="18" r="16.5"/>';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 36 36"><g fill="${fill}" stroke="${color}" stroke-width="${used ? 1 : 2}">${shape}</g><text x="18" y="22" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="${ink}">${prn}</text></svg>`;
  return 'image://data:image/svg+xml,' + encodeURIComponent(svg);
}

function SnapshotChart({
  option,
  label,
  height = 300,
  onSelect,
}: {
  option: EChartsCoreOption;
  label: string;
  height?: number;
  onSelect?: (prn: string) => void;
}) {
  const categories = useRef('');
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.EChartsType | undefined>(undefined);
  const select = useRef(onSelect);
  select.current = onSelect;
  useEffect(() => {
    if (!element.current) return;
    const instance = echarts.init(element.current, undefined, { renderer: 'canvas' });
    chart.current = instance;
    instance.on('click', (p) => {
      const row = p.data as { prn?: string };
      if (row?.prn) select.current?.(row.prn);
    });
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(element.current);
    return () => {
      resize.disconnect();
      instance.dispose();
      chart.current = undefined;
    };
  }, []);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    const key = JSON.stringify(option.xAxis);
    const previous = instance.getOption()?.dataZoom as { start: number; end: number }[] | undefined;
    const zoom = option.dataZoom as Record<string, unknown>[] | undefined;
    // Keep the selected window across epochs; changing a filter resets the window.
    const next =
      key === categories.current && previous?.length && zoom?.length
        ? {
            ...option,
            dataZoom: zoom.map((z) => ({
              ...z,
              start: previous[0].start,
              end: previous[0].end,
              startValue: undefined,
              endValue: undefined,
            })),
          }
        : option;
    categories.current = key;
    instance.setOption(next, { notMerge: true, lazyUpdate: true });
  }, [option]);
  return <div role="img" aria-label={label} ref={element} style={{ height, width: '100%' }} />;
}

function SatelliteLive({
  sessionKey,
  runId,
  sample,
  active,
}: {
  sessionKey: string;
  runId: string;
  sample: number;
  active: boolean;
}) {
  const [data, setData] = useState<SatelliteSnapshot>();
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now() / 1000);
  const [system, setSystem] = useState('all');
  const [band, setBand] = useState('all');
  const [prn, setPrn] = useState('all');
  useEffect(() => {
    setData(undefined);
    setSystem('all');
    setBand('all');
    setPrn('all');
  }, [sessionKey, runId]);
  useEffect(() => {
    let disposed = false,
      pending = false,
      lastPoll = -Infinity;
    setError('');
    const poll = async () => {
      const tick = performance.now();
      if (disposed || pending || document.hidden || !active || tick - lastPoll < 1000) return;
      lastPoll = tick;
      pending = true;
      setNow(Date.now() / 1000);
      try {
        const next = await invoke<SatelliteSnapshot | null>('realtime_satellites', { sessionId: sessionKey, runId });
        if (!disposed) {
          setError('');
          if (next) setData((old) => (!old || next.sequence > old.sequence ? next : old));
        }
      } catch (e) {
        if (!disposed) setError(String(e));
      } finally {
        pending = false;
      }
    };
    const visibility = () => {
      if (!document.hidden) void poll();
    };
    void poll();
    const timer = setInterval(() => void poll(), 1000);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [sessionKey, runId, active]);
  const stale = !active || !data || now - data.publishedAt > Math.max(3, 3 * sample);
  const counts = useMemo(() => satelliteCounts(data?.satellites ?? []), [data]);
  const systems = useMemo(() => [...new Set(data?.satellites.map((s) => s.system) ?? [])].sort(), [data]);
  const rows = useMemo(
    () =>
      data?.satellites
        .filter((s) => system === 'all' || s.system === system)
        .sort((a, b) => a.prn.localeCompare(b.prn)) ?? [],
    [data, system],
  );
  const bands = useMemo(() => [...new Set(rows.flatMap((s) => s.signals.map((f) => f.band)))].sort(), [rows]);
  const selected = useMemo(() => rows.filter((s) => prn === 'all' || s.prn === prn), [rows, prn]);

  const fill = (color: string) => ({
    type: 'linear' as const,
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color },
      { offset: 1, color: color + '90' },
    ],
  });
  const countOption = useMemo<EChartsCoreOption>(() => {
    const groups = counts.bands.flatMap((r, i) => (i > 0 && counts.bands[i - 1].system !== r.system ? [null, r] : [r]));
    const labels = groups.map(() => '');
    for (const name of systems) {
      const indices = groups.flatMap((r, i) => (r?.system === name ? [i] : []));
      if (indices.length) labels[indices[Math.floor(indices.length / 2)]] = name;
    }
    return {
      animation: false,
      tooltip: { trigger: 'axis', renderMode: 'richText' },
      grid: { left: 36, right: 16, bottom: 68, top: 38 },
      xAxis: [
        {
          type: 'category',
          data: groups.map((r) => r?.band ?? ''),
          ...axis,
          axisLabel: { color: '#C7D3E4', fontSize: 12, fontWeight: 600, interval: 0 },
        },
        {
          type: 'category',
          position: 'bottom',
          offset: 27,
          data: labels,
          ...axis,
          axisLabel: {
            interval: 0,
            formatter: (v: string) => (v ? `{${v}|${v}}` : ''),
            rich: Object.fromEntries(
              systems.map((v) => [v, { color: systemColors[v], fontWeight: 700, fontSize: 13 }]),
            ),
          },
        },
      ],
      yAxis: { type: 'value', minInterval: 1, ...axis },
      series: [
        {
          type: 'bar',
          barCategoryGap: '0%',
          data: groups.map((r) =>
            r
              ? {
                  value: r.count,
                  name: r.system + ' ' + r.band,
                  itemStyle: {
                    color: fill(systemColors[r.system]),
                    borderColor: '#121C2A',
                    borderWidth: 1.5,
                    borderRadius: [5, 5, 0, 0],
                  },
                }
              : null,
          ),
          label: { show: true, position: 'top', distance: 8, fontSize: 18, fontWeight: 700, color: '#EDF4FF' },
        },
      ],
    };
  }, [counts, systems]);
  const skyOption = useMemo<EChartsCoreOption>(
    () => ({
      animation: false,
      tooltip: {
        renderMode: 'richText',
        formatter: (p: unknown) => {
          const row = (p as { data: { prn: string; note: string } }).data;
          return row.prn + '\n' + row.note;
        },
      },
      polar: { radius: '86%', center: ['50%', '50%'] },
      angleAxis: {
        type: 'value',
        min: 0,
        max: 360,
        startAngle: 90,
        clockwise: true,
        interval: 90,
        axisLine: { lineStyle: { color: '#52647F' } },
        splitLine: { lineStyle: { color: '#8095B22E' } },
        axisLabel: {
          color: '#C3D0E1',
          fontSize: 13,
          fontWeight: 600,
          margin: 12,
          formatter: (v: number) => ({ 0: '北 N', 90: '东 E', 180: '南 S', 270: '西 W' })[v] ?? '',
        },
      },
      radiusAxis: {
        min: 0,
        max: 90,
        inverse: true,
        interval: 30,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#7D91AD', fontSize: 11, formatter: '{value}°' },
        splitLine: { lineStyle: { color: '#8095B22E' } },
        splitArea: { show: true, areaStyle: { color: ['#131E2C', '#162233', '#19273A'] } },
      },
      series: [
        {
          type: 'scatter',
          coordinateSystem: 'polar',
          symbolSize: 36,
          itemStyle: { opacity: 1 },
          emphasis: { scale: 1.3 },
          data: selected
            .filter((s) => s.azimuth !== null && s.elevation !== null)
            .map((s) => ({
              prn: s.prn,
              value: [s.elevation, s.azimuth],
              symbol: satelliteSymbol(s.prn, s.system, s.used),
              note: `方位 ${s.azimuth?.toFixed(1)}° · 高度 ${s.elevation?.toFixed(1)}°\n${s.used === null ? '参与状态未知' : s.used ? '参与解算' : '未参与解算'}\n${s.signals.map((f) => `${f.band} ${f.signal} ${f.cn0 ?? '—'} dB-Hz`).join('\n')}`,
            })),
        },
      ],
    }),
    [selected],
  );
  const signalOption = useMemo<EChartsCoreOption>(() => {
    const signals = selected.flatMap((s) =>
      s.signals.filter((f) => band === 'all' || f.band === band).map((f) => ({ sat: s, ...f })),
    );
    const labels = signals.map(() => '');
    for (const sat of selected) {
      const indices = signals.flatMap((r, i) => (r.sat.prn === sat.prn ? [i] : []));
      if (indices.length) labels[indices[Math.floor(indices.length / 2)]] = sat.prn;
    }
    return {
      animation: false,
      tooltip: { trigger: 'axis', renderMode: 'richText' },
      grid: { left: 42, right: 12, top: 36, bottom: signals.length > 18 ? 112 : 76 },
      xAxis: [
        {
          type: 'category',
          data: signals.map((r) => r.band),
          ...axis,
          axisLabel: { color: '#AEBFD6', fontSize: 11, interval: 0 },
        },
        {
          type: 'category',
          position: 'bottom',
          offset: 23,
          data: labels,
          ...axis,
          axisLabel: { color: '#E0E9F6', fontSize: 12, fontWeight: 700, interval: 0 },
        },
      ],
      yAxis: {
        type: 'value',
        name: 'dB-Hz',
        min: 0,
        max: Math.max(60, ...signals.map((r) => Math.ceil((r.cn0 ?? 0) / 15) * 15)),
        interval: 15,
        ...axis,
        nameTextStyle: { color: '#94A9C5', padding: [0, 0, 6, 0] },
      },
      dataZoom:
        signals.length > 18
          ? [
              {
                type: 'slider',
                xAxisIndex: [0, 1],
                startValue: 0,
                endValue: 17,
                bottom: 15,
                height: 22,
                showDetail: false,
                borderColor: '#354860',
                fillerColor: '#597EA833',
                handleStyle: { color: '#87A5CB' },
                dataBackground: { lineStyle: { color: '#536985' }, areaStyle: { color: '#31445F' } },
              },
              { type: 'inside', xAxisIndex: [0, 1], zoomOnMouseWheel: false, moveOnMouseWheel: true },
            ]
          : [],
      series: [
        {
          type: 'bar',
          barCategoryGap: '20%',
          barMaxWidth: 48,
          data: signals.map((r) => ({
            name: r.sat.prn + ' ' + r.band,
            value: r.cn0,
            itemStyle: {
              color: fill(systemColors[r.sat.system]),
              borderColor: systemColors[r.sat.system],
              borderWidth: 1,
              borderRadius: [4, 4, 0, 0],
              opacity: r.used === false ? 0.55 : 1,
            },
          })),
          label: {
            show: true,
            position: 'top',
            color: '#D9E6F6',
            fontSize: 12,
            fontWeight: 600,
            formatter: (p: unknown) => {
              const v = (p as { value: unknown }).value;
              return typeof v === 'number' ? Math.round(v).toString() : '';
            },
          },
        },
      ],
    };
  }, [selected, band]);
  return (
    <div className="satellite-details">
      {error && <Alert type="warning" title="卫星详情暂不可用，解算继续" description={error} />}
      <div className="satellite-summary">
        <div className="satellite-totals">
          <span>
            观测 <b>{counts.total}</b> 颗
          </span>
          <span>
            参与 <b>{counts.used}</b> 颗
          </span>
          {counts.unknown > 0 && (
            <span>
              未知 <b>{counts.unknown}</b> 颗
            </span>
          )}
        </div>
        <div className="satellite-epoch">
          <Tag color={stale ? 'default' : 'green'}>
            {!active ? '已停止' : stale ? '等待新快照 / 数据已陈旧' : '实时 · 1 Hz'}
          </Tag>
          {data && (
            <span>
              GPST {data.week} / {data.tow.toFixed(3)}
            </span>
          )}
        </div>
      </div>
      <section className="satellite-chart-panel satellite-count-panel">
        <div className="satellite-panel-heading">
          <h4>星座与频点</h4>
          <span>每个频点的观测卫星数</span>
        </div>
        <div className="satellite-system-key">
          {systems.map((name) => (
            <span key={name} style={{ borderColor: systemColors[name] + '55' }}>
              <img src={systemFlags[name]} alt="" />
              <strong style={{ color: systemColors[name] }}>{systemNames[name] ?? name}</strong>
            </span>
          ))}
        </div>
        <SnapshotChart label="各星座频点观测卫星数" option={countOption} height={280} />
      </section>
      <Space wrap className="satellite-filters">
        <span>筛选</span>
        <Select
          aria-label="卫星星座"
          value={system}
          onChange={(v) => {
            setSystem(v);
            setPrn('all');
            setBand('all');
          }}
          options={[{ value: 'all', label: '全部星座' }, ...systems.map((value) => ({ value, label: value }))]}
        />
        <Select
          aria-label="卫星频点"
          value={band}
          onChange={setBand}
          options={[{ value: 'all', label: '全部频点' }, ...bands.map((value) => ({ value, label: value }))]}
        />
        <Select
          aria-label="单颗卫星"
          showSearch
          value={prn}
          onChange={setPrn}
          options={[{ value: 'all', label: '全部卫星' }, ...rows.map((s) => ({ value: s.prn, label: s.prn }))]}
        />
      </Space>
      <div className="satellite-detail-charts">
        <section className="satellite-chart-panel">
          <div className="satellite-panel-heading">
            <h4>卫星天空图</h4>
            <span>点选卫星查看各频点</span>
          </div>
          <SnapshotChart label="卫星天空图" option={skyOption} height={500} onSelect={setPrn} />
        </section>
        <section className="satellite-chart-panel">
          <div className="satellite-panel-heading">
            <h4>当前载噪比</h4>
            <span>同星频点相邻 · 横向拖动查看更多</span>
          </div>
          <SnapshotChart label="当前历元卫星载噪比" option={signalOption} height={500} />
        </section>
      </div>
      <p className="chart-note">
        总数按 PRN
        去重；各频点分别计数。实心为参与、空心为未参与、菱形为未知；重叠编号可悬停查看；无当期角度的卫星不绘制天空位置。仅显示当前引擎保留的信号，不保存逐星历史。
      </p>
    </div>
  );
}

/**
 * Shown directly: the monitor mounts this only while the 卫星详情 tab is open (destroyOnHidden), so the 1 Hz
 * subscription starts on entering the tab and is released on leaving it or when the window is hidden.
 */
export default function SatelliteDetails(props: {
  sessionKey: string;
  runId: string;
  sample: number;
  active: boolean;
}) {
  return <SatelliteLive {...props} />;
}
