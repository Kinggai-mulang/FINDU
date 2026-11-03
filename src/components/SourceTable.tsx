import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Alert, Button, Form, Input, Modal, Segmented, Space, Table, Tag } from 'antd';
import { ProfileOutlined } from '@ant-design/icons';
import type { NtripMountpoint, NtripProbe } from '../../contracts';
import { isDesktop } from '../services/files';
import { readStored, writeStored } from '../services/storage';
import { distanceKm, parsePosition } from '../services/ntrip-geo';

type Row = NtripMountpoint & { distance?: number };
type Kind = 'all' | 'OBS' | 'SSR';

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
  return (
    <Modal
      open={open}
      title="NTRIP 源表"
      width={1040}
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
      </Space>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table<Row>
        size="small"
        rowKey="mountpoint"
        loading={loading}
        dataSource={data}
        pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
        scroll={{ y: 340 }}
        locale={{ emptyText: loading ? '正在获取…' : error ? '获取失败' : '尚未获取源表' }}
        rowSelection={{
          type: 'radio',
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
        columns={[
          { title: '挂载点', dataIndex: 'mountpoint', width: 150 },
          { title: '站点', dataIndex: 'identifier', width: 120, ellipsis: true },
          { title: '格式', dataIndex: 'format', width: 90 },
          { title: '系统', dataIndex: 'systems', width: 110, ellipsis: true },
          { title: '国家', dataIndex: 'country', width: 60 },
          {
            title: '距离',
            dataIndex: 'distance',
            width: 80,
            render: (v?: number) => (v === undefined ? '—' : v < 10 ? `${v.toFixed(1)} km` : `${Math.round(v)} km`),
          },
          {
            title: '内容',
            dataIndex: 'kinds',
            width: 120,
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
            title: '认证',
            dataIndex: 'authentication',
            width: 60,
            render: (v: string) => ({ N: '无', B: '基本', D: '摘要' })[v] ?? (v || '—'),
          },
          { title: '码率', dataIndex: 'bitrate', width: 70, render: (v: number | null) => (v ? `${v}` : '—') },
        ]}
      />
      {current && (
        <div className="chart-note" style={{ marginTop: 8 }}>
          {current.mountpoint}：{current.details || '源表没有给出消息列表'}
          {current.nmea && '　· 该挂载点要求客户端上报位置（VRS / 网格站），探测可能收不到数据'}
        </div>
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
