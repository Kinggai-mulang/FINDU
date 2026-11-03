import { useMemo, useState, type ReactNode, type ThHTMLAttributes } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Form,
  Input,
  Modal,
  Popover,
  Segmented,
  Space,
  Table,
  Tag,
  Tooltip,
  type TableColumnsType,
} from 'antd';
import { ProfileOutlined, SettingOutlined } from '@ant-design/icons';
import type { NtripMountpoint, NtripProbe } from '../../contracts';
import { isDesktop } from '../services/files';
import { readStored, writeStored } from '../services/storage';
import { distanceKm, parsePosition } from '../services/ntrip-geo';

type Row = NtripMountpoint & { distance?: number };
type Kind = 'all' | 'OBS' | 'SSR';
type Layout = { widths: Record<string, number>; hidden: string[] };

const MIN_WIDTH = 50;
const MAX_WIDTH = 700;
const defaultWidths: Record<string, number> = {
  mountpoint: 150,
  identifier: 150,
  format: 100,
  systems: 220,
  network: 120,
  country: 70,
  position: 160,
  distance: 90,
  kinds: 160,
  authentication: 70,
  bitrate: 80,
  details: 280,
};
// Columns that matter for choosing a mountpoint are shown first; the rest can be turned on from the column menu.
const defaultHidden = ['network', 'position', 'details'];
const columnTitles: Record<string, string> = {
  mountpoint: '挂载点',
  identifier: '站点',
  format: '格式',
  systems: '导航系统',
  network: '网络',
  country: '国家',
  position: '位置',
  distance: '距离',
  kinds: '内容',
  authentication: '认证',
  bitrate: '码率',
  details: '消息列表',
};
const authentication: Record<string, string> = { N: '无', B: '基本', D: '摘要' };

function readLayout(): Layout {
  const saved = readStored<Partial<Layout>>('sourceTableLayout', {});
  return {
    widths: { ...defaultWidths, ...(saved.widths ?? {}) },
    hidden: Array.isArray(saved.hidden) ? saved.hidden : defaultHidden,
  };
}

/** Header cell with a drag handle on its right edge; dragging changes only this column. */
function ResizableTitle({
  width,
  onResize,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & { width?: number; onResize?: (width: number) => void }) {
  if (!width || !onResize) return <th {...rest}>{children}</th>;
  const start = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const from = event.clientX;
    const move = (e: MouseEvent) => onResize(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + e.clientX - from)));
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.classList.remove('column-resizing');
    };
    document.body.classList.add('column-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  };
  return (
    <th {...rest} style={{ ...rest.style, position: 'relative' }}>
      {children}
      <span
        className="column-resize-handle"
        role="separator"
        aria-label="拖动调整列宽"
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 8, cursor: 'col-resize', zIndex: 1 }}
        onMouseDown={start}
        onClick={(e) => e.stopPropagation()}
      />
    </th>
  );
}

/** Long text is cut at the column edge; the full value shows on hover. */
const full = (value: string | undefined): ReactNode =>
  value ? (
    <Tooltip title={value} placement="topLeft">
      <span>{value}</span>
    </Tooltip>
  ) : (
    '—'
  );

function SourceTableDialog({
  open,
  onClose,
  prefix,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  prefix: string;
  onPick: (mountpoint: string) => void;
}) {
  const form = Form.useFormInstance();
  const [rows, setRows] = useState<NtripMountpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [position, setPosition] = useState(() => readStored<string>('sourceTablePosition', ''));
  const [layout, setLayout] = useState(readLayout);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ mountpoint: string; result?: NtripProbe; error?: string } | null>(null);
  const connection = () => ({
    host: String(form.getFieldValue(`${prefix}_NTRIP_CasterHost`) ?? '').trim(),
    port: Number(form.getFieldValue(`${prefix}_NTRIP_Port`) || 2101),
    user: String(form.getFieldValue(`${prefix}_NTRIP_UserID`) ?? ''),
    password: String(form.getFieldValue(`${prefix}_NTRIP_Password`) ?? ''),
  });
  const load = async () => {
    const { host, port, user, password } = connection();
    setLoading(true);
    setError('');
    setProbe(null);
    try {
      const table = await invoke<NtripMountpoint[]>('ntrip_sourcetable', { host, port, user, password });
      setRows(table);
      setSelected('');
    } catch (e) {
      setRows([]);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };
  const runProbe = async () => {
    const { host, port, user, password } = connection();
    setProbing(true);
    setProbe({ mountpoint: selected });
    try {
      const result = await invoke<NtripProbe>('ntrip_probe', { host, port, mountpoint: selected, user, password });
      setProbe({ mountpoint: selected, result });
    } catch (e) {
      setProbe({ mountpoint: selected, error: String(e) });
    } finally {
      setProbing(false);
    }
  };
  const changeLayout = (next: Layout) => {
    setLayout(next);
    writeStored('sourceTableLayout', next);
  };
  const resize = (key: string) => (width: number) =>
    changeLayout({ ...layout, widths: { ...layout.widths, [key]: width } });
  const here = parsePosition(position);
  const data = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => kind === 'all' || r.kinds.includes(kind))
      .filter(
        (r) =>
          !q ||
          [r.mountpoint, r.identifier, r.country, r.format, r.network, r.systems].some((v) =>
            v.toLowerCase().includes(q),
          ),
      )
      .map((r) => ({
        ...r,
        distance:
          here && r.latitude !== null && r.longitude !== null ? distanceKm(here, [r.latitude, r.longitude]) : undefined,
      }))
      .sort((a, b) =>
        here
          ? (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.mountpoint.localeCompare(b.mountpoint)
          : a.mountpoint.localeCompare(b.mountpoint),
      );
  }, [rows, query, kind, here]);
  const current = rows.find((r) => r.mountpoint === selected);
  const text = (key: 'mountpoint' | 'identifier' | 'format' | 'systems' | 'network' | 'country') => ({
    sorter: (a: Row, b: Row) => a[key].localeCompare(b[key]),
    render: (v: string) => full(v),
  });
  const all: TableColumnsType<Row> = [
    { key: 'mountpoint', dataIndex: 'mountpoint', ...text('mountpoint') },
    { key: 'identifier', dataIndex: 'identifier', ...text('identifier') },
    { key: 'format', dataIndex: 'format', ...text('format') },
    { key: 'systems', dataIndex: 'systems', ...text('systems') },
    { key: 'network', dataIndex: 'network', ...text('network') },
    { key: 'country', dataIndex: 'country', ...text('country') },
    {
      key: 'position',
      render: (_, r) =>
        r.latitude === null || r.longitude === null ? '—' : full(`${r.latitude.toFixed(3)}, ${r.longitude.toFixed(3)}`),
    },
    {
      key: 'distance',
      dataIndex: 'distance',
      sorter: (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity),
      render: (v?: number) => (v === undefined ? '—' : v < 10 ? `${v.toFixed(1)} km` : `${Math.round(v)} km`),
    },
    {
      key: 'kinds',
      dataIndex: 'kinds',
      render: (kinds: string[], r) => (
        <>
          {kinds.map((k) => (
            <Tag key={k} color={k === 'OBS' ? 'blue' : k === 'EPH' ? 'green' : 'purple'}>
              {k}
            </Tag>
          ))}
          {r.nmea && <Tag color="orange">需位置</Tag>}
        </>
      ),
    },
    {
      key: 'authentication',
      dataIndex: 'authentication',
      render: (v: string) => authentication[v] ?? (v || '—'),
    },
    {
      key: 'bitrate',
      dataIndex: 'bitrate',
      sorter: (a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0),
      render: (v: number | null) => (v ? `${v}` : '—'),
    },
    { key: 'details', dataIndex: 'details', render: (v: string) => full(v) },
  ];
  const shown = all
    .filter((c) => !layout.hidden.includes(String(c.key)))
    .map((c) => {
      const key = String(c.key);
      const width = layout.widths[key] ?? defaultWidths[key];
      return {
        ...c,
        title: columnTitles[key],
        width,
        ellipsis: key !== 'kinds',
        onHeaderCell: () => ({ width, onResize: resize(key) }),
      };
    });
  const tableWidth = shown.reduce((sum, c) => sum + Number(c.width), 0) + 40;
  const columnMenu = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 140 }}>
      {Object.keys(columnTitles).map((key) => (
        <Checkbox
          key={key}
          checked={!layout.hidden.includes(key)}
          disabled={key === 'mountpoint'}
          onChange={(e) =>
            changeLayout({
              ...layout,
              hidden: e.target.checked ? layout.hidden.filter((k) => k !== key) : [...layout.hidden, key],
            })
          }
        >
          {columnTitles[key]}
        </Checkbox>
      ))}
      <Button size="small" onClick={() => changeLayout({ widths: { ...defaultWidths }, hidden: [...defaultHidden] })}>
        还原列宽与显示
      </Button>
    </div>
  );
  return (
    <Modal
      open={open}
      title="NTRIP 源表"
      width="min(1500px, 96vw)"
      style={{ top: 32 }}
      onCancel={onClose}
      destroyOnHidden
      afterOpenChange={(visible) => {
        if (visible && connection().host && !rows.length) void load();
      }}
      footer={
        <Space>
          <Button onClick={onClose}>关闭</Button>
          <Button disabled={!selected || probing} loading={probing} onClick={() => void runProbe()}>
            探测所选挂载点（8 秒）
          </Button>
          <Button
            type="primary"
            disabled={!selected}
            onClick={() => {
              onPick(selected);
              onClose();
            }}
          >
            使用此挂载点
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Button loading={loading} onClick={() => void load()}>
          {rows.length ? '重新获取' : '获取源表'}
        </Button>
        <Input
          aria-label="搜索挂载点"
          allowClear
          style={{ width: 220 }}
          placeholder="搜索挂载点、国家、格式"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Segmented
          aria-label="内容筛选"
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          options={[
            { value: 'all', label: '全部' },
            { value: 'OBS', label: '含观测' },
            { value: 'SSR', label: '含 SSR 改正' },
          ]}
        />
        <Input
          aria-label="大致位置"
          allowClear
          style={{ width: 260 }}
          placeholder="大致位置 纬度, 经度（按距离排序）"
          value={position}
          status={position && !here ? 'error' : undefined}
          onChange={(e) => {
            setPosition(e.target.value);
            writeStored('sourceTablePosition', e.target.value);
          }}
        />
        <Popover trigger="click" placement="bottomRight" title="显示的列" content={columnMenu}>
          <Button icon={<SettingOutlined />}>列</Button>
        </Popover>
        <span className="chart-note">拖动表头右侧边缘调整列宽；内容过长时悬停可看全文</span>
      </Space>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table<Row>
        size="small"
        rowKey="mountpoint"
        loading={loading}
        dataSource={data}
        tableLayout="fixed"
        components={{ header: { cell: ResizableTitle } }}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ x: tableWidth, y: 'max(200px, calc(100vh - 520px))' }}
        locale={{ emptyText: loading ? '正在获取…' : error ? '获取失败' : '尚未获取源表' }}
        rowSelection={{
          type: 'radio',
          columnWidth: 40,
          selectedRowKeys: selected ? [selected] : [],
          onChange: (keys) => {
            setSelected(String(keys[0] ?? ''));
            setProbe(null);
          },
        }}
        onRow={(r) => ({
          onClick: () => {
            setSelected(r.mountpoint);
            setProbe(null);
          },
          onDoubleClick: () => {
            onPick(r.mountpoint);
            onClose();
          },
        })}
        columns={shown}
      />
      {current && (
        <Descriptions
          size="small"
          bordered
          column={{ xs: 1, md: 2, xl: 3 }}
          style={{ marginTop: 12 }}
          title={`所选：${current.mountpoint}`}
          items={[
            { key: 'identifier', label: '站点', children: current.identifier || '—' },
            { key: 'format', label: '格式', children: current.format || '—' },
            { key: 'systems', label: '导航系统', children: current.systems || '—' },
            { key: 'network', label: '网络', children: current.network || '—' },
            { key: 'country', label: '国家', children: current.country || '—' },
            {
              key: 'position',
              label: '位置',
              children:
                current.latitude === null || current.longitude === null
                  ? '—'
                  : `${current.latitude.toFixed(4)}, ${current.longitude.toFixed(4)}`,
            },
            {
              key: 'authentication',
              label: '认证',
              children: authentication[current.authentication] ?? (current.authentication || '—'),
            },
            { key: 'bitrate', label: '码率', children: current.bitrate ? `${current.bitrate} bit/s` : '—' },
            {
              key: 'nmea',
              label: '需要上报位置',
              children: current.nmea ? '是（虚拟站 / 网格站，探测可能收不到数据）' : '否',
            },
            { key: 'details', label: '消息列表', span: 'filled', children: current.details || '源表没有给出消息列表' },
          ]}
        />
      )}
      {probe && probe.mountpoint === selected && (
        <Alert
          style={{ marginTop: 8 }}
          type={probe.error ? 'warning' : probing ? 'info' : 'success'}
          showIcon
          message={
            probe.error ??
            (probe.result
              ? `实际收到（${probe.result.windowSeconds.toFixed(0)} 秒，${(probe.result.bytes / 1024).toFixed(0)} KiB）：` +
                probe.result.messages.map((m) => `${m.id}×${m.count}`).join('　')
              : '正在连接并接收…')
          }
        />
      )}
    </Modal>
  );
}

/** Mountpoint field with a button that opens the caster's source table; picking fills the field. */
export function MountpointInput({
  value,
  onChange,
  prefix,
  disabled,
  placeholder,
}: {
  value?: string;
  onChange?: (value: string) => void;
  prefix: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Space.Compact block>
        <Input
          autoComplete="off"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange?.(e.target.value)}
        />
        <Button
          aria-label="浏览源表"
          icon={<ProfileOutlined />}
          disabled={disabled || !isDesktop()}
          onClick={() => setOpen(true)}
        >
          源表
        </Button>
      </Space.Compact>
      <SourceTableDialog
        open={open}
        onClose={() => setOpen(false)}
        prefix={prefix}
        onPick={(mountpoint) => onChange?.(mountpoint)}
      />
    </>
  );
}
