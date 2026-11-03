import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Alert, App, Button, Segmented, Space, Tag } from 'antd';
import { DownloadOutlined, PlusOutlined } from '@ant-design/icons';
import type { BiasComparison, ComparisonOutcome, ProductComparison } from '../../contracts';
import { fileColors } from '../components/chart-data';
import { NoData, PageHeading, Panel } from '../components/common';
import { InputEditor } from '../components/InputEditor';
import { ComparisonFailures, InputNotice } from '../components/InputNotice';
import { SatellitePicker } from '../components/SatellitePicker';
import { biasCsv } from '../services/bias-compare';
import { emptySet, problem, testName, toBiasSet, toProductSet, useInputs } from '../services/compare-inputs';
import { exportText, isDesktop } from '../services/files';
import { useFileDrop } from '../services/file-drop';
import { workbenchEngine } from '../services/native-engine';
import { comparisonCsv } from '../services/product-compare';
import { palette } from '../theme';
import { BiasResults } from './BiasCompare';
import { ProductResults } from './ProductCompare';
import '../product-compare.css';

const MAX_TESTS = 8;
type Section = 'orbit' | 'bias';
type Failure = { section: string; name: string; error: string };

/**
 * Product comparison: one reference and up to eight products, each with whatever BIA, SP3 and CLK files it has. The
 * orbit / clock comparison runs for the products that have SP3 files, the bias comparison for those that have BIA
 * files; what cannot be compared is named, and the rest is not held back.
 */
export default function Compare() {
  const { message } = App.useApp();
  const [inputs, update] = useInputs();
  const { reference, tests } = inputs;
  const [busy, setBusy] = useState(false);
  const [orbit, setOrbit] = useState<ProductComparison[]>([]);
  const [bias, setBias] = useState<BiasComparison[]>([]);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [section, setSection] = useState<Section>('orbit');
  const [convertLevel, setConvertLevel] = useState(0);
  const [exclude, setExclude] = useState<string[]>([]);
  const [compared, setCompared] = useState(false);
  useEffect(() => {
    if (isDesktop())
      void workbenchEngine
        .info()
        .then((info) => setConvertLevel(info.capabilities?.product_convert ?? 0))
        .catch(() => setConvertLevel(0));
  }, []);
  const noOrbit = problem(inputs, 'sp3');
  const noBias = problem(inputs, 'bia');
  const latest = useRef(0);
  const run = async (quiet = false) => {
    const ticket = ++latest.current;
    setBusy(true);
    setErrors([]);
    setFailures([]);
    const orbitTests = tests.flatMap((t, i) => (t.sp3.length ? [{ ...toProductSet(t), name: testName(t, i) }] : []));
    const biasTests = tests.flatMap((t, i) => (t.bia.length ? [{ ...toBiasSet(t), name: testName(t, i) }] : []));
    const [orbitOut, biasOut] = await Promise.allSettled([
      noOrbit
        ? Promise.resolve(undefined)
        : invoke<ComparisonOutcome<ProductComparison>>('compare_products', {
            request: { reference: toProductSet(reference), tests: orbitTests, exclude },
          }),
      noBias
        ? Promise.resolve(undefined)
        : invoke<ComparisonOutcome<BiasComparison>>('compare_biases', {
            request: { reference: toBiasSet(reference), tests: biasTests, exclude },
          }),
    ]);
    if (ticket !== latest.current) return;
    const failed: Failure[] = [];
    const problems: string[] = [];
    const take = <T,>(out: PromiseSettledResult<ComparisonOutcome<T> | undefined>, label: string): T[] => {
      if (out.status === 'rejected') {
        problems.push(`${label}：${String(out.reason)}`);
        return [];
      }
      failed.push(...(out.value?.failures ?? []).map((f) => ({ section: label, ...f })));
      return out.value?.results ?? [];
    };
    const orbitResults = take(orbitOut, '轨道和钟差');
    const biasResults = take(biasOut, '偏差');
    setOrbit(orbitResults);
    setBias(biasResults);
    setFailures(failed);
    setErrors(problems);
    setCompared(true);
    setSection((current) => (current === 'orbit' && !orbitResults.length && biasResults.length ? 'bias' : current));
    setBusy(false);
    if (quiet) return;
    if (failed.length || problems.length) message.warning('有产品没能对比，原因见下方');
    else
      message.success(
        `已完成对比：${[
          noOrbit ? '' : `轨道钟差 ${orbitResults.length} 组`,
          noBias ? '' : `偏差 ${biasResults.length} 组`,
        ]
          .filter(Boolean)
          .join('、')}`,
      );
  };
  // Changing the satellite selection recomputes after a short pause, once a comparison has been made.
  const runLatest = useRef(run);
  runLatest.current = run;
  const done = useRef(false);
  done.current = compared;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!done.current) return;
    const timer = setTimeout(() => void runLatest.current(true), 500);
    return () => clearTimeout(timer);
  }, [exclude]);
  const candidates = [...new Set([...orbit.flatMap((r) => r.candidates), ...bias.flatMap((r) => r.satellites)])].sort();
  const flagged = [
    ...new Set([
      ...orbit.flatMap((r) => r.satellites.filter((s) => s.outlier).map((s) => s.sat)),
      ...bias.flatMap((r) => r.items.filter((i) => i.outlier).map((i) => i.sat)),
    ]),
  ].sort();
  const classes = Object.assign({}, ...orbit.map((r) => r.orbitClasses), ...bias.map((r) => r.orbitClasses));
  const excluded = orbit[0]?.excluded ?? bias[0]?.excluded ?? [];
  // results come back in the order of the test products that have files
  const detectedSign = (index: number) =>
    tests[index]?.bia.length ? bias[tests.slice(0, index).filter((t) => t.bia.length > 0).length]?.sign : undefined;
  // A file dropped beside the boxes would otherwise vanish without a word.
  const { ref: pageRef } = useFileDrop<HTMLDivElement>({
    accepts: () => true,
    multiple: true,
    onDrop: () => void message.warning('请把文件拖到“参考产品”或某个“对比产品”的框里'),
    hint: '',
    priority: 1,
  });
  const shown: Section = section === 'orbit' && !orbit.length && bias.length ? 'bias' : section;
  const empty = (why: string) => <NoData text={busy ? '正在对比…' : why || '选好产品后点击“开始对比”'} />;
  return (
    <div ref={pageRef} className="page product-compare-page bias-compare-page">
      <PageHeading
        eyebrow="PRODUCT COMPARISON"
        title="产品对比"
        description="以一份最终产品为参考，核查其他产品的轨道、钟差、信号空间误差和码 / 相位偏差；有什么文件就比什么。"
        actions={
          <Space wrap>
            <Button
              icon={<DownloadOutlined />}
              disabled={shown === 'orbit' ? !orbit.length : !bias.length}
              onClick={() =>
                void (shown === 'orbit'
                  ? exportText('product-comparison.csv', comparisonCsv(orbit), 'text/csv')
                  : exportText('bias-comparison.csv', biasCsv(bias), 'text/csv'))
              }
            >
              导出 CSV
            </Button>
            <Button
              type="primary"
              loading={busy}
              disabled={(!!noOrbit && !!noBias) || !isDesktop()}
              onClick={() => void run()}
            >
              开始对比
            </Button>
          </Space>
        }
      />
      <Panel title="选择产品" extra={<Tag>最多 {MAX_TESTS} 组对比</Tag>}>
        <InputNotice inputs={inputs} />
        <div className="product-inputs">
          <InputEditor
            title="参考产品"
            set={reference}
            onChange={(change) => update((all) => ({ ...all, reference: change(all.reference) }))}
            accent={palette.success}
          />
          <div className="product-tests">
            {tests.map((t, i) => (
              <InputEditor
                key={i}
                test
                title={`对比产品 ${i + 1}`}
                set={t}
                accent={fileColors[i % fileColors.length]}
                converter={{ level: convertLevel }}
                detected={detectedSign(i)}
                onChange={(change) =>
                  update((all) => ({ ...all, tests: all.tests.map((x, k) => (k === i ? change(x) : x)) }))
                }
                onRemove={
                  tests.length > 1
                    ? () => update((all) => ({ ...all, tests: all.tests.filter((_, k) => k !== i) }))
                    : undefined
                }
              />
            ))}
            {tests.length < MAX_TESTS && (
              <Button
                icon={<PlusOutlined />}
                onClick={() =>
                  update((all) => ({ ...all, tests: [...all.tests, emptySet(`对比产品 ${all.tests.length + 1}`)] }))
                }
              >
                添加对比产品
              </Button>
            )}
          </div>
        </div>
        <div className="chart-note" style={{ marginTop: 8 }}>
          BIA 偏差、SP3 轨道、CLK 钟差可以一起拖进来，也可以拖整个文件夹：有 SP3 的产品比较轨道和钟差（钟差缺省时用 SP3
          里的钟差），有 BIA 的产品比较偏差（SP3 用来判断 GEO / IGSO / MEO，CLK
          用于带钟差的几项）。可以放多个文件拼接多天， 两份产品需覆盖同一时段。实时产品可以先用 IPSPOS 从录制流转成 SP3
          / CLK 或 Bias-SINEX 再比较。
        </div>
      </Panel>
      {errors.length > 0 && (
        <Alert type="error" showIcon style={{ marginTop: 12 }} message="对比失败" description={errors.join('；')} />
      )}
      <ComparisonFailures failures={failures} />
      {candidates.length > 0 && (
        <div style={{ margin: '12px 0' }}>
          <SatellitePicker
            satellites={candidates}
            excluded={exclude}
            flagged={flagged}
            busy={busy}
            classes={classes}
            onChange={setExclude}
          />
        </div>
      )}
      <Panel
        title="对比结果"
        extra={
          orbit.length || bias.length ? (
            <Tag>
              {orbit.length ? `轨道钟差 ${orbit.length} 组` : ''}
              {orbit.length && bias.length ? ' · ' : ''}
              {bias.length ? `偏差 ${bias.length} 组` : ''}
            </Tag>
          ) : undefined
        }
      >
        {orbit.length > 0 && bias.length > 0 && (
          <Segmented
            aria-label="对比内容"
            style={{ marginBottom: 12 }}
            value={section}
            onChange={(v) => setSection(v as Section)}
            options={[
              { value: 'orbit', label: '轨道与钟差' },
              { value: 'bias', label: '偏差' },
            ]}
          />
        )}
        {excluded.length > 0 && (orbit.length > 0 || bias.length > 0) && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`下面的统计已剔除 ${excluded.length} 颗卫星：${excluded.join(' ')}`}
          />
        )}
        {shown === 'orbit' ? (
          orbit.length ? (
            <ProductResults results={orbit} />
          ) : (
            empty(noOrbit ? `轨道和钟差没有可比的内容：${noOrbit}` : '')
          )
        ) : bias.length ? (
          <BiasResults results={bias} />
        ) : (
          empty(noBias ? `偏差没有可比的内容：${noBias}` : '')
        )}
      </Panel>
    </div>
  );
}
