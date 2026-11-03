import { memo, useMemo, useState } from 'react';
import { Alert, Segmented, Select, Space, Table, Tabs, Tag } from 'antd';
import type { ProductComparison, ProductSatellite } from '../../contracts';
import { Chart } from '../components/Charts';
import { fileColors } from '../components/chart-data';
import {
  hourlyOption,
  barMetrics,
  satelliteBarOption,
  type BarMetric,
  seriesNames,
  seriesOption,
  type SeriesKey,
} from '../components/product-charts';
import { cm, systemNames } from '../services/product-compare';
import '../product-compare.css';

export const ProductResults = memo(function ProductResults({ results }: { results: ProductComparison[] }) {
  const [tab, setTab] = useState('overview');
  const [product, setProduct] = useState(0);
  const [system, setSystem] = useState('all');
  const [sat, setSat] = useState<string | undefined>();
  const [metric, setMetric] = useState<SeriesKey>('r');
  const [barMetric, setBarMetric] = useState<BarMetric>('d3');
  const current = results[Math.min(product, results.length - 1)];
  const allSats = useMemo(() => [...new Set(results.flatMap((r) => r.satellites.map((s) => s.sat)))].sort(), [results]);
  const selectedSat =
    sat && allSats.includes(sat) ? sat : (current.satellites.find((s) => s.outlier)?.sat ?? allSats[0]);
  const systems = [...new Set(current.satellites.map((s) => s.system))];
  const hints = results.flatMap((r) => r.hints.map((h) => (results.length > 1 ? `${r.name}：${h}` : h)));
  const overview = results.flatMap((r, i) =>
    r.systems.map((s) => ({
      key: `${i}-${s.system}`,
      product: r.name,
      color: fileColors[i % fileColors.length],
      ...s,
    })),
  );
  const rows = current.satellites.filter((s) => system === 'all' || s.system === system);
  const satelliteColumns = [
    {
      title: '卫星',
      dataIndex: 'sat',
      width: 70,
      sorter: (a: ProductSatellite, b: ProductSatellite) => (a.sat < b.sat ? -1 : 1),
    },
    {
      title: '三维 RMS / cm',
      width: 120,
      defaultSortOrder: 'descend' as const,
      sorter: (a: ProductSatellite, b: ProductSatellite) => a.d3.rms - b.d3.rms,
      render: (_: unknown, s: ProductSatellite) => (
        <span style={{ color: s.outlier ? '#f27d90' : undefined }}>{cm(s.d3.rms, 2)}</span>
      ),
    },
    {
      title: '径向 / cm',
      width: 90,
      sorter: (a: ProductSatellite, b: ProductSatellite) => a.r.rms - b.r.rms,
      render: (_: unknown, s: ProductSatellite) => cm(s.r.rms, 2),
    },
    {
      title: '切向 / cm',
      width: 90,
      sorter: (a: ProductSatellite, b: ProductSatellite) => a.a.rms - b.a.rms,
      render: (_: unknown, s: ProductSatellite) => cm(s.a.rms, 2),
    },
    {
      title: '法向 / cm',
      width: 90,
      sorter: (a: ProductSatellite, b: ProductSatellite) => a.c.rms - b.c.rms,
      render: (_: unknown, s: ProductSatellite) => cm(s.c.rms, 2),
    },
    { title: '最大 / cm', width: 90, render: (_: unknown, s: ProductSatellite) => cm(s.d3.max, 1) },
    {
      title: '钟差标准差 / cm',
      width: 130,
      sorter: (a: ProductSatellite, b: ProductSatellite) => (a.clock.std || 0) - (b.clock.std || 0),
      render: (_: unknown, s: ProductSatellite) => (s.clock.n ? cm(s.clock.std, 2) : '—'),
    },
    {
      title: '钟差阶跃',
      dataIndex: 'clockJumps',
      width: 90,
      render: (n: number) => (n ? <Tag color="orange">{n}</Tag> : '0'),
    },
    { title: 'SISRE / cm', width: 100, render: (_: unknown, s: ProductSatellite) => cm(s.sisre, 2) },
    { title: '覆盖率', width: 80, render: (_: unknown, s: ProductSatellite) => `${(s.coverage * 100).toFixed(0)}%` },
  ];
  return (
    <>
      {hints.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="需要注意"
          description={
            <ul className="product-hints">
              {hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
          }
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'overview',
            label: '总览',
            children: (
              <Table
                size="small"
                pagination={false}
                dataSource={overview}
                columns={[
                  {
                    title: '对比产品',
                    dataIndex: 'product',
                    render: (v: string, r) => (
                      <>
                        <span className="product-dot" style={{ background: r.color }} /> {v}
                      </>
                    ),
                  },
                  { title: '系统', dataIndex: 'system', width: 80, render: (v: string) => systemNames[v] ?? v },
                  { title: '卫星数', dataIndex: 'sats', width: 80 },
                  { title: '三维 / cm', width: 90, render: (_: unknown, r) => cm(r.d3Median, 1) },
                  { title: '径向 / cm', width: 90, render: (_: unknown, r) => cm(r.rMedian, 1) },
                  { title: '切向 / cm', width: 90, render: (_: unknown, r) => cm(r.aMedian, 1) },
                  { title: '法向 / cm', width: 90, render: (_: unknown, r) => cm(r.cMedian, 1) },
                  { title: '全体 RMS / cm', width: 110, render: (_: unknown, r) => cm(r.d3Rms, 1) },
                  { title: '钟差标准差 / cm', width: 120, render: (_: unknown, r) => cm(r.clockStdMedian, 1) },
                  { title: 'SISRE / cm', width: 100, render: (_: unknown, r) => cm(r.sisreMedian, 1) },
                  { title: '覆盖率', width: 80, render: (_: unknown, r) => `${(r.coverage * 100).toFixed(0)}%` },
                ]}
                footer={() => (
                  <span className="chart-note">
                    三维、径向、切向、法向和钟差为每颗卫星 RMS（钟差为标准差）的系统内中位数；全体 RMS
                    为所有卫星历元合并。 钟差已逐历元扣除同系统的公共偏移，SISRE 另外扣除了各星的固定偏差。
                  </span>
                )}
              />
            ),
          },
          {
            key: 'satellites',
            label: '各卫星',
            children: (
              <>
                <Space wrap style={{ marginBottom: 8 }}>
                  <Segmented
                    aria-label="直方图指标"
                    value={barMetric}
                    onChange={(v) => setBarMetric(v as BarMetric)}
                    options={(Object.keys(barMetrics) as BarMetric[]).map((k) => ({
                      value: k,
                      label: barMetrics[k].label,
                    }))}
                  />
                  <Segmented
                    aria-label="系统筛选"
                    value={system}
                    onChange={(v) => setSystem(String(v))}
                    options={[
                      { value: 'all', label: '全部' },
                      ...systems.map((s) => ({ value: s, label: systemNames[s] ?? s })),
                    ]}
                  />
                </Space>
                <Chart
                  label={`各卫星${barMetrics[barMetric].label}`}
                  height={300}
                  option={satelliteBarOption(
                    results.map((r) => ({
                      ...r,
                      satellites: r.satellites.filter((x) => system === 'all' || x.system === system),
                    })),
                    barMetric,
                  )}
                />
                {results.length > 1 && (
                  <Space wrap style={{ margin: '8px 0' }}>
                    <span className="chart-note">下表显示：</span>
                    <Segmented
                      aria-label="对比产品"
                      value={product}
                      onChange={(v) => setProduct(Number(v))}
                      options={results.map((r, i) => ({ value: i, label: r.name }))}
                    />
                  </Space>
                )}
                <Table
                  size="small"
                  rowKey="sat"
                  dataSource={rows}
                  columns={satelliteColumns}
                  pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
                  rowClassName={(s) => (s.outlier ? 'product-outlier' : '')}
                  onRow={(s) => ({
                    onClick: () => {
                      setSat(s.sat);
                      setTab('series');
                    },
                  })}
                />
              </>
            ),
          },
          {
            key: 'series',
            label: '时间序列',
            children: (
              <>
                <Space wrap style={{ marginBottom: 8 }}>
                  <Select
                    aria-label="卫星"
                    showSearch
                    style={{ width: 120 }}
                    value={selectedSat}
                    onChange={setSat}
                    options={allSats.map((s) => ({ value: s, label: s }))}
                  />
                  <Segmented
                    aria-label="指标"
                    value={metric}
                    onChange={(v) => setMetric(v as SeriesKey)}
                    options={(Object.keys(seriesNames) as SeriesKey[]).map((k) => ({
                      value: k,
                      label: seriesNames[k],
                    }))}
                  />
                  <span className="chart-note">点击“各卫星”表格中的一行可直接跳到这里</span>
                </Space>
                <Chart label="单星时间序列" height={340} option={seriesOption(results, selectedSat, metric)} />
              </>
            ),
          },
          {
            key: 'hourly',
            label: '分时统计',
            children: <Chart label="分时轨道 RMS" height={320} option={hourlyOption(results)} />,
          },
          {
            key: 'coverage',
            label: '覆盖情况',
            children: (
              <ul className="product-coverage">
                {results.map((r) => (
                  <li key={r.name}>
                    <strong>{r.name}</strong>：共同卫星 {r.satellites.length} 颗，时间系统 {r.timeSystem || '未标注'}
                    ，参考采样间隔 {r.stepSeconds || '—'} s。
                    {r.testOnly.length > 0 && <div>只在对比产品中：{r.testOnly.join(' ')}</div>}
                    {r.referenceOnly.length > 0 && <div>参考中有、对比产品缺少：{r.referenceOnly.join(' ')}</div>}
                    {r.testOnly.length === 0 && r.referenceOnly.length === 0 && <div>两份产品的卫星完全一致。</div>}
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
      />
    </>
  );
});
