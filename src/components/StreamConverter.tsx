import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Alert, App, Button, Checkbox, Collapse, Input, Segmented, Space } from 'antd';
import { FolderOpenOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { isDesktop } from '../services/files';
import { useFileDrop } from '../services/file-drop';

export type ConvertKind = 'orbit' | 'bias';
/** What was recorded: an RTCM / IGS SSR stream, Galileo HAS or BeiDou PPP-B2b. */
export type ConvertSource = 'ssr' | 'has' | 'b2b';
export interface ConvertInfo {
  source: ConvertSource;
  kind: ConvertKind;
}

/** Engine capability level `product_convert` that each conversion needs. */
export const convertLevel = (kind: ConvertKind, source: ConvertSource) =>
  source !== 'ssr' ? 3 : kind === 'bias' ? 2 : 1;
export type ConvertResult = { sp3?: string; clk?: string; bia?: string; directory: string; log: string };

/** UTC time as the engine option takes it; empty is allowed (RINEX ephemerides carry the week). */
export const validStartTime = (text: string) =>
  text.trim() === '' || /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text.trim());

/** Which of the converter's inputs a recorded file is for, judged by its name; the rest is returned as `unknown`. */
export function assignStreamFiles(
  paths: string[],
  bias: boolean,
): { ssr?: string; osb?: string; navi?: string; unknown: string[] } {
  const out: { ssr?: string; osb?: string; navi?: string; unknown: string[] } = { unknown: [] };
  for (const path of paths) {
    const name = path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
    // ephemerides first: a stream named BIAS_EPH2IGS carries broadcast ephemerides, not biases
    // (a receiver's own recording, ROVE_*, carries the ephemerides of a B2b or HAS product recorded next to it)
    if (/\.(rnx|nav)$/.test(name) || /\.\d\d[nlgphq]$/.test(name) || /brdc|_mn\.|eph|rove/.test(name))
      out.navi ??= path;
    else if (/prod|ssr|corr|\.has$/.test(name)) out.ssr ??= path;
    else if (bias && /bias|osb|\.bia$/.test(name)) out.osb ??= path;
    else out.unknown.push(path);
  }
  return out;
}

/** A path box that takes a file dropped on it, typed or pasted, or chosen with the dialog. */
function PathField({
  label,
  value,
  onChange,
  onFiles,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Several files dropped on this box are sorted by the converter, not squeezed into one input. */
  onFiles: (paths: string[]) => void;
  placeholder: string;
}) {
  const { ref, dragging } = useFileDrop<HTMLDivElement>({
    accepts: () => true,
    multiple: true,
    onDrop: (paths) => (paths.length === 1 ? onChange(paths[0]) : onFiles(paths)),
    hint: `请拖入${label}`,
    priority: 30,
  });
  return (
    <div ref={ref} className={`stream-field${dragging ? ' drag-active' : ''}`} data-field={label}>
      <Space.Compact block>
        <Input
          aria-label={label}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <Button
          aria-label={`选择${label}`}
          icon={<FolderOpenOutlined />}
          disabled={!isDesktop()}
          onClick={async () => {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const picked = await open({ multiple: false });
            if (typeof picked === 'string') onChange(picked);
          }}
        />
      </Space.Compact>
    </div>
  );
}

/**
 * Turns a recorded real-time correction stream into SP3 / clock files (`orbit`) or a Bias-SINEX file (`bias`) with the
 * engine, then hands the new files to the product editor. The engine decodes the stream and applies the SSR exactly as
 * the PPP solver does.
 */
export function StreamConverter({
  kind = 'orbit',
  name,
  level,
  onDone,
}: {
  kind?: ConvertKind;
  name: string;
  /** The `product_convert` capability level of the engine; 0 = none. */
  level: number;
  onDone: (paths: string[], directory: string, info: ConvertInfo) => void;
}) {
  const { message } = App.useApp();
  const bias = kind === 'bias';
  const [source, setSource] = useState<ConvertSource>('ssr');
  const supported = level >= convertLevel(kind, source);
  const recording = source === 'has' ? 'HAS 记录' : source === 'b2b' ? 'B2b 记录' : 'SSR 流';
  const [ssr, setSsr] = useState('');
  const [osb, setOsb] = useState('');
  const [navi, setNavi] = useState('');
  const [start, setStart] = useState('');
  const [clock, setClock] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Several recorded files dropped on the converter are sorted into the inputs by name.
  const assign = (paths: string[]) => {
    const found = assignStreamFiles(paths, bias);
    if (found.ssr) setSsr(found.ssr);
    if (found.osb) setOsb(found.osb);
    if (found.navi) setNavi(found.navi);
    const taken = [found.ssr, found.osb, found.navi].filter(Boolean).length;
    if (taken) message.success(`已填入 ${taken} 个文件`);
    if (found.unknown.length)
      message.warning(
        `无法从文件名判断用途：${found.unknown.map((p) => p.replaceAll('\\', '/').split('/').pop()).join('、')}，请拖到对应的输入框里`,
      );
  };
  const drop = useFileDrop<HTMLDivElement>({
    accepts: () => true,
    multiple: true,
    onDrop: assign,
    hint: '请拖入录制的 SSR 流、偏差流或广播星历',
    priority: 25,
  });
  // Orbits need the SSR stream and ephemerides; biases need a stream and something that fixes the GPS week. A HAS or B2b
  // recording carries its own time: orbits need it and the ephemerides, biases only the recording.
  const timed = source !== 'ssr';
  const ready = timed
    ? ssr !== '' && (!bias || !clock || navi !== '') && (bias || navi !== '')
    : bias
      ? (ssr !== '' || osb !== '') &&
        (navi !== '' || start.trim() !== '') &&
        validStartTime(start) &&
        (!clock || (ssr !== '' && navi !== ''))
      : ssr !== '' && navi !== '' && validStartTime(start);
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const request = { kind, source, ssr, bias: timed ? '' : osb, navi, startTime: timed ? '' : start.trim(), name };
      // The narrow-lane with clock needs the clock of the same stream: the orbit conversion writes it next to the biases.
      const orbit =
        bias && clock
          ? await invoke<ConvertResult>('convert_ssr_products', { request: { ...request, kind: 'orbit', bias: '' } })
          : undefined;
      const result = await invoke<ConvertResult>('convert_ssr_products', { request });
      onDone(
        [result.sp3, result.clk, result.bia, orbit?.clk].filter((p): p is string => !!p),
        result.directory,
        { source, kind },
      );
      message.success(
        bias
          ? clock
            ? '已生成 Bias-SINEX 和钟差，并加入这组产品'
            : '已生成 Bias-SINEX，并加入这组产品'
          : '已生成 SP3 / CLK，并加入这组产品',
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Collapse
      size="small"
      items={[
        {
          key: 'convert',
          label: (
            <span>
              <ThunderboltOutlined /> {bias ? '从实时录制流生成 Bias-SINEX' : '从实时录制流生成 SP3 / CLK'}
            </span>
          ),
          children: (
            <div ref={drop.ref} className={`stream-converter${drop.dragging ? ' drag-active' : ''}`}>
              <Segmented
                aria-label="录制内容"
                value={source}
                onChange={(v) => setSource(v as ConvertSource)}
                options={[
                  { value: 'ssr', label: 'SSR 流（RTCM / IGS）' },
                  { value: 'has', label: 'Galileo HAS' },
                  { value: 'b2b', label: '北斗 PPP-B2b' },
                ]}
              />
              {!supported && (
                <Alert
                  type="info"
                  showIcon
                  message={`当前引擎不支持这项转换，请更换为包含该功能的 IPSPOS 引擎（清单需声明 product_convert ≥ ${convertLevel(kind, source)}）`}
                />
              )}
              <PathField
                label={recording}
                value={ssr}
                onChange={setSsr}
                onFiles={assign}
                placeholder={
                  source === 'has'
                    ? '录制的 Galileo HAS：.has 页面记录、OEM 日志或 Septentrio SBF'
                    : source === 'b2b'
                      ? '录制的北斗 PPP-B2b：Unicore / SinoGNSS 接收机日志'
                      : bias
                        ? '录制的 SSR 流（含码 / 相位偏差的部分，与偏差流至少填一个）'
                        : '录制的 SSR 改正流（RTCM SSR 或 IGS-SSR）'
                }
              />
              {bias && !timed && (
                <PathField
                  label="偏差流"
                  value={osb}
                  onChange={setOsb}
                  onFiles={assign}
                  placeholder="单独录制的 OSB 流（可选，同一信号以它为准）"
                />
              )}
              <PathField
                label="广播星历"
                value={navi}
                onChange={setNavi}
                onFiles={assign}
                placeholder={
                  timed
                    ? bias
                      ? '可选：同时生成钟差时需要。RINEX 导航文件、带星历的 RTCM3 流或接收机 Unicore 日志'
                      : '广播星历：RINEX 导航文件、带星历的 RTCM3 流，或接收机 Unicore 日志（B2b 用同一台接收机的日志）'
                    : bias
                      ? '可选：RINEX 导航文件，仅用来确定 GPS 周；也可只填起始时间'
                      : '广播星历：RINEX 导航文件，或带星历的 RTCM3 流'
                }
              />
              {!timed && (
                <Input
                  aria-label="起始时间"
                  value={start}
                  status={validStartTime(start) ? undefined : 'error'}
                  placeholder={
                    bias
                      ? '起始时间（UTC，没有 RINEX 星历时必填）：如 2026-09-19 17:34:00'
                      : '起始时间（UTC，可选）：星历是流时填，如 2026-10-18 09:58:00'
                  }
                  onChange={(e) => setStart(e.target.value)}
                />
              )}
              {bias && (
                <Checkbox checked={clock} onChange={(e) => setClock(e.target.checked)}>
                  同时生成钟差（.clk，需要 SSR 流和广播星历），用于“窄巷+钟差”
                </Checkbox>
              )}
              <Button
                type="primary"
                loading={busy}
                disabled={!supported || !ready || !isDesktop()}
                onClick={() => void run()}
              >
                生成并加入
              </Button>
              {error && <Alert type="error" showIcon message="生成失败" description={error} />}
              <div className="chart-note">
                可以把录制的文件直接拖进来：拖到某个输入框里只填那一个，拖到框外的空白处则按文件名自动分到改正数据、偏差流和广播星历。
                HAS 和 B2b
                的记录自带时间，不用填起始时间；它们只有码偏差，轨道参考卫星天线相位中心，对比时会自动去掉每颗卫星的径向常数。
              </div>
              <div className="chart-note">
                {bias
                  ? '转换由 IPSPOS 引擎完成，输出在 runtime/exports/ssr-products 下。偏差按 5 分钟间隔写成 OSB，符号按 RTCM 标准；不同来源的符号可能相反，对比时由偏差页对照参考自动判断。'
                  : '转换由 IPSPOS 引擎完成，输出在 runtime/exports/ssr-products 下。使用 RINEX 星历时 Galileo 取最近的一组，用流星历时优先 I/NAV。'}
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}
