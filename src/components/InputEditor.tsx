import { useState } from 'react';
import { App, Button, Checkbox, Input, Segmented, Space, Tag, Tooltip } from 'antd';
import { CloseOutlined, FolderOpenOutlined, InboxOutlined } from '@ant-design/icons';
import type { BiasSign } from '../../contracts';
import { signText } from '../services/bias-compare';
import {
  addInputPaths,
  classifyInputPath,
  emptySet,
  kindLabels,
  removeInputPath,
  type InputKind,
  type InputSet,
} from '../services/compare-inputs';
import { expandDropped, isDesktop } from '../services/files';
import { useFileDrop } from '../services/file-drop';
import { StreamConverter, type ConvertInfo } from './StreamConverter';

const fileName = (path: string) => path.replaceAll('\\', '/').split('/').pop() ?? path;
const tagColors: Record<InputKind, string> = { bia: 'blue', sp3: 'purple', clk: 'geekblue' };
const kindOrder: InputKind[] = ['bia', 'sp3', 'clk'];
const why: Record<InputKind, string> = {
  bia: '码 / 相位偏差',
  sp3: '轨道',
  clk: '钟差',
};

/**
 * One product: bias (.BIA), orbit (.SP3) and clock (.CLK) files in any mix, filled by dropping files or folders, the
 * dialog or pasted paths. The comparison uses whichever of them both sides have.
 */
export function InputEditor({
  title,
  set,
  onChange,
  onRemove,
  accent,
  converter,
  test,
  detected,
}: {
  title: string;
  set: InputSet;
  /** Changes are functions of the latest set, so files dropped one after the other never overwrite each other. */
  onChange: (change: (latest: InputSet) => InputSet) => void;
  onRemove?: () => void;
  accent?: string;
  /** Offered for products that come from a recorded real-time stream; `level` = the engine's conversion capability. */
  converter?: { level: number };
  /** A product compared with the reference (not the reference itself): it gets the sign / phase-centre choices. */
  test?: boolean;
  /** The sign the last bias comparison used for this product; shown next to the sign choice. */
  detected?: BiasSign;
}) {
  const { message } = App.useApp();
  const [typed, setTyped] = useState('');
  // Files and folders alike; what is no bias, orbit or clock file is left out, and said so.
  const add = async (dropped: string[], info?: ConvertInfo) => {
    const paths = await expandDropped(dropped);
    const { rejected } = addInputPaths(emptySet(), paths);
    // HAS and B2b corrections are applied to broadcast orbits, which refer to the antenna phase centre
    onChange((latest) => {
      const { set: next } = addInputPaths(latest, paths);
      return info && info.source !== 'ssr' ? { ...next, apc: true } : next;
    });
    const compressed = rejected.filter((p) => classifyInputPath(p) === 'compressed');
    if (compressed.length) message.warning(`${compressed.map(fileName).join('、')} 是压缩文件，请先解压再添加`);
    else if (rejected.length === paths.length && rejected.length)
      message.warning(
        `无法识别 ${rejected.map(fileName).slice(0, 4).join('、')}：需要 .BIA / .BSX 偏差、.sp3 轨道或 .clk 钟差文件`,
      );
    else if (rejected.length) message.info(`已忽略 ${rejected.length} 个不相关的文件`);
  };
  const { ref, dragging } = useFileDrop<HTMLDivElement>({
    accepts: () => true,
    onDrop: add,
    multiple: true,
    priority: 20,
    hint: '请拖入 .BIA 偏差、.sp3 轨道、.clk 钟差文件，可以一起拖，也可以拖整个文件夹',
  });
  const submit = () => {
    void add(
      typed
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    setTyped('');
  };
  const files = kindOrder.flatMap((kind) => set[kind].map((path) => ({ path, kind })));
  return (
    <div ref={ref} className={`product-editor ${dragging ? 'drag-active' : ''}`} data-role={title}>
      <div className="product-editor-head">
        <span className="product-dot" style={{ background: accent }} />
        {onRemove ? (
          <Input
            aria-label={`${title}名称`}
            size="small"
            value={set.name}
            placeholder={title}
            onChange={(e) => onChange((latest) => ({ ...latest, name: e.target.value }))}
            style={{ maxWidth: 220 }}
          />
        ) : (
          <strong>{title}</strong>
        )}
        {onRemove && (
          <Tooltip title="移除这组产品">
            <Button aria-label={`移除${title}`} size="small" type="text" icon={<CloseOutlined />} onClick={onRemove} />
          </Tooltip>
        )}
        {test && (
          <Tooltip title="Galileo HAS、北斗 B2b 这类加在广播星历上的改正，轨道参考卫星天线相位中心，与最终产品的质心相差一个径向常数。勾选后去掉每颗卫星的径向常数再比较。">
            <Checkbox
              aria-label={`${title}轨道为天线相位中心`}
              checked={!!set.apc}
              onChange={(e) => onChange((latest) => ({ ...latest, apc: e.target.checked }))}
            >
              轨道为天线相位中心
            </Checkbox>
          </Tooltip>
        )}
        {test && (
          <Tooltip title="不同来源的偏差符号约定可能相反。自动：用码偏差和参考的相关方向、再用宽巷是否一致来判断；也可以手动指定。">
            <Segmented
              size="small"
              aria-label={`${title}偏差符号`}
              value={set.sign ?? 'auto'}
              onChange={(v) => onChange((latest) => ({ ...latest, sign: v as InputSet['sign'] }))}
              options={[
                { value: 'auto', label: '自动符号' },
                { value: 'keep', label: '不取反' },
                { value: 'invert', label: '取反' },
              ]}
            />
          </Tooltip>
        )}
        {test && signText(detected) && (
          <Tag color="orange" data-testid="sign-note">
            {signText(detected)}
          </Tag>
        )}
      </div>
      <div className="product-files">
        {files.length === 0 && (
          <span className="product-hint">
            <InboxOutlined /> 把 .BIA / .SP3 / .CLK 文件或文件夹拖到这里，三类可以一起拖
          </span>
        )}
        {files.map(({ path, kind }) => (
          <Tooltip key={path} title={`${path}（${why[kind]}）`}>
            <Tag closable color={tagColors[kind]} onClose={() => onChange((latest) => removeInputPath(latest, path))}>
              {kindLabels[kind]} · {fileName(path)}
            </Tag>
          </Tooltip>
        ))}
      </div>
      <Space.Compact block>
        <Input
          aria-label={`${title}路径`}
          value={typed}
          placeholder="粘贴文件路径，多个用 | 分隔"
          onChange={(e) => setTyped(e.target.value)}
          onPressEnter={submit}
        />
        <Button aria-label={`${title}添加路径`} disabled={!typed.trim()} onClick={submit}>
          添加
        </Button>
        <Button
          aria-label={`${title}选择文件`}
          icon={<FolderOpenOutlined />}
          disabled={!isDesktop()}
          onClick={async () => {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const picked = await open({
              multiple: true,
              filters: [
                {
                  name: 'BIA / SP3 / CLK',
                  extensions: ['bia', 'BIA', 'bsx', 'BSX', 'sp3', 'SP3', 'clk', 'CLK'],
                },
              ],
            });
            if (picked) void add(Array.isArray(picked) ? picked : [picked]);
          }}
        >
          选择
        </Button>
      </Space.Compact>
      {converter && (
        <>
          {(['orbit', 'bias'] as const).map((kind) => (
            <StreamConverter
              key={kind}
              kind={kind}
              name={set.name || title}
              level={converter.level}
              onDone={(paths, _directory, info) => void add(paths, info)}
            />
          ))}
        </>
      )}
    </div>
  );
}
