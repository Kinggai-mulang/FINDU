import { memo, useMemo, useState } from 'react';
import { Alert, Button, Collapse, Segmented, Select, Space, Table, Tabs, Tag } from 'antd';
import type { BiasComparison, BiasItem, BiasKind, BiasRow } from '../../contracts';
import { Chart } from '../components/Charts';
import {
  biasBarOption,
  epochSeriesOption,
  heatmapHeight,
  heatmapOption,
  histogramOption,
  rmsBarHeight,
  rmsBarOption,
  signalList,
  signalTitle,
} from '../components/bias-charts';
import { fileColors } from '../components/chart-data';
import { NoData } from '../components/common';
import { fixed, isCyclic, isReferenceOnly, kindNames, kindNotes, kindOrder, unitLabel } from '../services/bias-compare';
import { systemNames } from '../services/product-compare';
import '../product-compare.css';

/** Signals drawn as histogram cards before "show all". */
const CARD_LIMIT = 6;
/** Hints shown before "show the rest". */
const HINT_LIMIT = 4;

type Row = BiasRow & { key: string; product: string; color: string };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : NaN;
};

/** One figure per product for the kind: the share inside the ambiguity limit, or the median RMS. */
function headline(result: BiasComparison, kind: BiasKind) {
  const rows = result.rows.filter((r) => r.kind === kind);
  if (!rows.length) return undefined;
  const cyclic = isCyclic(kind);
  const samples = (r: BiasRow) => r.histogram.counts.reduce((a, b) => a + b, 0);
  const total = rows.reduce((a, r) => a + samples(r), 0) || 1;
  const within = rows.reduce((a, r) => a + (r.epochWithin ?? 0) * samples(r), 0) / total;
  return {
    rows: rows.length,
    within: cyclic ? within : undefined,
    rms: median(rows.map((r) => r.totalRms)),
    unit: cyclic ? '周' : 'ns',
    outliers: rows.reduce((a, r) => a + r.outliers, 0),
  };
}

export const BiasResults = memo(function BiasResults({ results }: { results: BiasComparison[] }) {
  const present = kindOrder.filter((k) => results.some((r) => r.rows.some((row) => row.kind === k)));
  const [tab, setTab] = useState('overview');
  const [chosen, setKind] = useState<BiasKind>('wl');
  const [pick, setPick] = useState<string | undefined>();
  const [product, setProduct] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [allHints, setAllHints] = useState(false);
  const kind = present.includes(chosen) ? chosen : (present[0] ?? 'code');
  const signals = useMemo(() => signalList(results), [results]);
  const selected = signals.find((s) => s.key === pick) ?? signals.find((s) => s.kind === kind) ?? signals[0];
  const current = results[Math.min(product, results.length - 1)];
  const hints = results.flatMap((r) => r.hints.map((h) => (results.length > 1 ? `${r.name}：${h}` : h)));
  const rows: Row[] = results.flatMap((r, i) =>
    r.rows
      .filter((row) => row.kind === kind)
      .map((row) => ({
        ...row,
        key: `${i}-${row.system}-${row.signal}`,
        product: r.name,
        color: fileColors[i % fileColors.length],
      })),
  );
  const cards = signals.filter((s) => s.kind === kind);
  const shown = showAll ? cards : cards.slice(0, CARD_LIMIT);
  const items = current.items.filter((i) => selected && i.system === selected.system && i.signal === selected.signal);
  const detail = (key: string) => {
    setPick(key);
    setTab('satellites');
  };
  const cyclicSelected = selected && isCyclic(selected.kind);
  return (
    <>
      {hints.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="需要注意"
          description={
            <>
              <ul className="product-hints">
                {(allHints ? hints : hints.slice(0, HINT_LIMIT)).map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              {hints.length > HINT_LIMIT && (
                <Button size="small" type="link" onClick={() => setAllHints(!allHints)}>
                  {allHints ? '收起' : `展开其余 ${hints.length - HINT_LIMIT} 条`}
                </Button>
              )}
            </>
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
              <>
                <Space direction="vertical" size={6} style={{ width: '100%', marginBottom: 12 }}>
                  <Segmented
                    aria-label="偏差类型"
                    value={kind}
                    onChange={(v) => {
                      setKind(v as BiasKind);
                      setShowAll(false);
                    }}
                    options={present.map((k) => ({ value: k, label: kindNames[k] }))}
                  />
                  <span className="chart-note">{kindNotes[kind]}</span>
                </Space>
                {rows.length === 0 ? (
                  <NoData text="两份产品里没有这一类可以比较的偏差" />
                ) : (
                  <>
                    <div className="bias-tiles">
                      {results.map((r, i) => {
                        const h = headline(r, kind);
                        if (!h)
                          return (
                            <div key={r.name} className="bias-tile" data-testid="bias-tile">
                              <span className="bias-tile-name">{r.name}</span>
                              <span>无可比的{kindNames[kind]}</span>
                              <span className="bias-tile-note">未提供此类偏差，或没有共同有效样本</span>
                            </div>
                          );
                        return (
                          <div key={r.name} className="bias-tile" data-testid="bias-tile">
                            <span className="bias-tile-name">
                              <span className="product-dot" style={{ background: fileColors[i % fileColors.length] }} />
                              {r.name}
                            </span>
                            <strong>
                              {h.within !== undefined
                                ? `${(h.within * 100).toFixed(0)}%`
                                : `${h.rms.toFixed(2)} ${h.unit}`}
                            </strong>
                            <span className="bias-tile-note">
                              {h.within !== undefined
                                ? `落在 ±0.1 周内 · RMS 中位数 ${h.rms.toFixed(3)} 周`
                                : `各信号 RMS 的中位数 · ${h.rows} 个信号`}
                              {h.outliers > 0 ? ` · 异常卫星 ${h.outliers}` : ''}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <div className="bias-section-title">各信号的总体 RMS</div>
                    <Chart
                      label={`${kindNames[kind]} 各信号 RMS`}
                      height={rmsBarHeight(results, kind)}
                      option={rmsBarOption(results, kind)}
                    />
                    <div className="bias-section-title">
                      差的分布
                      <span className="chart-note">
                        {isCyclic(kind)
                          ? '小数周的直方图，虚线为 ±0.1 周；越集中在中间越好'
                          : '各卫星各历元的差，越窄越好'}
                      </span>
                    </div>
                    <div className="bias-grid">
                      {shown.map((s) => {
                        const own = rows.filter((r) => r.system === s.system && r.signal === s.signal);
                        return (
                          <div key={s.key} className="bias-card" data-testid="bias-histogram">
                            <div className="bias-card-head">
                              <strong>{signalTitle(s.system, s.signal)}</strong>
                              <span className="chart-note">
                                {own
                                  .map(
                                    (r) =>
                                      `${results.length > 1 ? `${r.product} ` : ''}RMS ${fixed(r.totalRms, r.unit)}${
                                        r.epochWithin === null ? '' : ` · ${(r.epochWithin * 100).toFixed(0)}%`
                                      }`,
                                  )
                                  .join('　')}
                              </span>
                              <Button
                                size="small"
                                type="link"
                                aria-label={`查看${s.signal}详情`}
                                onClick={() => detail(s.key)}
                              >
                                详情
                              </Button>
                            </div>
                            <Chart
                              label={`${signalTitle(s.system, s.signal)} 分布`}
                              height={190}
                              option={histogramOption(results, s.system, s.signal)}
                            />
                          </div>
                        );
                      })}
                    </div>
                    {cards.length > CARD_LIMIT && (
                      <Button type="link" onClick={() => setShowAll(!showAll)}>
                        {showAll ? '收起' : `显示全部 ${cards.length} 个信号`}
                      </Button>
                    )}
                    <Collapse
                      ghost
                      items={[
                        {
                          key: 'table',
                          label: '详细数值表',
                          children: (
                            <Table
                              size="small"
                              pagination={false}
                              dataSource={rows}
                              rowClassName={(r) => (isReferenceOnly(r.kind) ? 'bias-reference-row' : '')}
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
                                {
                                  title: '系统',
                                  dataIndex: 'system',
                                  width: 80,
                                  render: (v: string) => systemNames[v] ?? v,
                                },
                                { title: '信号', dataIndex: 'signal', width: 130 },
                                { title: '卫星数', dataIndex: 'sats', width: 80 },
                                {
                                  title: '扣除的基准',
                                  width: 110,
                                  render: (_: unknown, r) => `${fixed(r.offset, r.unit)} ${unitLabel(r.unit)}`,
                                },
                                {
                                  title: '总体 RMS',
                                  width: 100,
                                  sorter: (a, b) => a.totalRms - b.totalRms,
                                  render: (_: unknown, r) => `${fixed(r.totalRms, r.unit)} ${unitLabel(r.unit)}`,
                                },
                                {
                                  title: '卫星平均差 RMS',
                                  width: 120,
                                  render: (_: unknown, r) => `${fixed(r.rms, r.unit)} ${unitLabel(r.unit)}`,
                                },
                                {
                                  title: '最大',
                                  width: 100,
                                  render: (_: unknown, r) => `${fixed(r.max, r.unit)} ${unitLabel(r.unit)}`,
                                },
                                {
                                  title: '日内稳定性',
                                  width: 110,
                                  render: (_: unknown, r) => `${fixed(r.temporalStd, r.unit)} ${unitLabel(r.unit)}`,
                                },
                                {
                                  title: '±0.1 周内',
                                  width: 100,
                                  render: (_: unknown, r: Row) =>
                                    r.epochWithin === null ? '—' : `${(r.epochWithin * 100).toFixed(0)}%`,
                                },
                                {
                                  title: '异常',
                                  dataIndex: 'outliers',
                                  width: 70,
                                  render: (n: number) => (n ? <Tag color="red">{n}</Tag> : '0'),
                                },
                              ]}
                              onRow={(r) => ({ onClick: () => detail(`${r.system}|${r.signal}`) })}
                            />
                          ),
                        },
                      ]}
                    />
                  </>
                )}
              </>
            ),
          },
          {
            key: 'satellites',
            label: '各卫星',
            children: (
              <>
                <Space wrap style={{ marginBottom: 8 }}>
                  <Select
                    aria-label="信号"
                    showSearch
                    style={{ width: 240 }}
                    value={selected?.key}
                    onChange={setPick}
                    options={kindOrder.map((k) => ({
                      label: kindNames[k],
                      options: signals
                        .filter((s) => s.kind === k)
                        .map((s) => ({ value: s.key, label: signalTitle(s.system, s.signal) })),
                    }))}
                  />
                  {results.length > 1 && (
                    <Segmented
                      aria-label="下图产品"
                      value={product}
                      onChange={(v) => setProduct(Number(v))}
                      options={results.map((r, i) => ({ value: i, label: r.name }))}
                    />
                  )}
                </Space>
                {selected && (
                  <>
                    <div className="bias-section-title">各卫星的平均差</div>
                    <Chart
                      label={`各卫星 ${selected.signal} 差`}
                      height={280}
                      option={biasBarOption(results, selected.system, selected.signal)}
                    />
                    {cyclicSelected && items.some((i) => i.series) && (
                      <>
                        <div className="bias-section-title">
                          每颗卫星随时间的差
                          <span className="chart-note">{current.name} · 颜色表示小数周差，深色为 ±0.1 周内</span>
                        </div>
                        <Chart
                          label={`${selected.signal} 卫星时间图`}
                          height={heatmapHeight(items.length)}
                          option={heatmapOption(current, selected.system, selected.signal)}
                        />
                      </>
                    )}
                    <div className="bias-pair">
                      <div>
                        <div className="bias-section-title">每个历元的 RMS</div>
                        <Chart
                          label={`${selected.signal} 历元 RMS`}
                          height={240}
                          option={epochSeriesOption(results, selected.system, selected.signal, 'rms')}
                        />
                      </div>
                      <div>
                        <div className="bias-section-title">
                          扣除的公共基准
                          <span className="chart-note">随时间漂移说明两份产品的基准在变</span>
                        </div>
                        <Chart
                          label={`${selected.signal} 扣除的基准`}
                          height={240}
                          option={epochSeriesOption(results, selected.system, selected.signal, 'datum')}
                        />
                      </div>
                    </div>
                    <Collapse
                      ghost
                      items={[
                        {
                          key: 'sats',
                          label: '各卫星数值表',
                          children: (
                            <Table<BiasItem>
                              size="small"
                              rowKey="sat"
                              dataSource={items}
                              pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
                              rowClassName={(i) => (i.outlier ? 'product-outlier' : '')}
                              columns={[
                                {
                                  title: '卫星',
                                  dataIndex: 'sat',
                                  width: 80,
                                  sorter: (a, b) => (a.sat < b.sat ? -1 : 1),
                                },
                                {
                                  title: '平均差',
                                  sorter: (a, b) => Math.abs(a.mean) - Math.abs(b.mean),
                                  defaultSortOrder: 'descend',
                                  render: (_: unknown, i) =>
                                    `${i.mean >= 0 ? '+' : ''}${i.mean.toFixed(3)} ${isCyclic(selected.kind) ? '周' : 'ns'}`,
                                },
                                { title: 'RMS', render: (_: unknown, i) => i.rms.toFixed(3) },
                                { title: '日内标准差', render: (_: unknown, i) => i.temporalStd.toFixed(3) },
                                { title: '历元数', dataIndex: 'n', width: 80 },
                                {
                                  title: '异常',
                                  dataIndex: 'outlier',
                                  width: 70,
                                  render: (v: boolean) => (v ? <Tag color="red">异常</Tag> : ''),
                                },
                              ]}
                            />
                          ),
                        },
                      ]}
                    />
                  </>
                )}
              </>
            ),
          },
          {
            key: 'coverage',
            label: '覆盖情况',
            children: (
              <ul className="product-coverage">
                {results.map((r) => (
                  <li key={r.name}>
                    <strong>{r.name}</strong>：共同比较 {new Set(r.items.map((i) => i.sat)).size} 颗卫星，时间系统{' '}
                    {r.timeSystem || '未标注'}。
                    {r.testOnly.length > 0 && <div>只在对比产品中：{r.testOnly.join(' ')}</div>}
                    {r.referenceOnly.length > 0 && <div>参考中有、对比产品缺少：{r.referenceOnly.join(' ')}</div>}
                    {r.testOnly.length === 0 && r.referenceOnly.length === 0 && <div>两份产品的卫星完全一致。</div>}
                    <div>
                      共同相位信号：
                      {r.rows
                        .filter((row) => row.kind === 'phase')
                        .map((row) => `${systemNames[row.system] ?? row.system} ${row.signal}（${row.sats} 星）`)
                        .join('；') || '无'}
                    </div>
                    <div>
                      北斗宽巷实际参与卫星：
                      {[
                        ...new Set(
                          r.items.filter((item) => item.system === 'C' && item.kind === 'wl').map((item) => item.sat),
                        ),
                      ]
                        .sort()
                        .join(' ') || '无可比信号对'}
                      。相位信号有交集不等于具备完整宽巷组合。
                    </div>
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
