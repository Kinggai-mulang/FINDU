import { invoke } from '@tauri-apps/api/core';
import { Alert, App, Button, Table, Tag, Tooltip } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import type { RealtimeSnapshot } from '../../../contracts';
import { NoData, Panel } from '../../components/common';
import { isDesktop } from '../../services/files';
import { formatBytes, roleNames, streamLabel } from './format';

/** Record-only sessions (GNSS_PMode = 0): per-stream throughput and the raw files on disk. */
export function RecordingMonitor({
  live,
  rates,
  now,
  active,
  sessionKey,
}: {
  live?: RealtimeSnapshot;
  rates: Record<string, number>;
  now: number;
  active: boolean;
  sessionKey?: string;
}) {
  const { message } = App.useApp();
  return (
    <div className="recording-monitor">
      <Alert
        showIcon
        type="info"
        title="仅录制原始数据 · 不执行定位解算"
        description="启用的挂载点分别保存原始字节，不要求观测与产品配对。此模式不解码卫星或产品，不生成 ENU、AR 和残差结果。"
      />
      <div className="stream-cards">
        {live?.heartbeat?.streams?.length ? (
          live.heartbeat.streams.map((s) => {
            const status = streamLabel(s, now, active);
            return (
              <section className="stream-card" key={s.role}>
                <header>
                  <strong>{roleNames[s.role] ?? s.role}</strong>
                  <Tag color={status.color}>{status.label}</Tag>
                </header>
                <div className="stream-rate">
                  {((rates[s.role] ?? 0) / 1024).toFixed(2)}
                  <small>KiB / s</small>
                </div>
                <dl>
                  <dt>累计接收</dt>
                  <dd>{formatBytes(s.bytes)}</dd>
                  <dt>最近到达</dt>
                  <dd>{s.lastArrival ? new Date(s.lastArrival * 1000).toISOString().slice(11, 19) + ' UTC' : '—'}</dd>
                  <dt>连接尝试</dt>
                  <dd>{s.attempts ?? s.reconnects}</dd>
                </dl>
              </section>
            );
          })
        ) : (
          <Panel title="等待连接">
            <NoData text="在数据源与配置中选择模式 0，填写至少一路挂载点后开始录制" />
          </Panel>
        )}
      </div>
      <Panel
        title="本地原始文件"
        extra={
          <Button
            icon={<FolderOpenOutlined />}
            disabled={!live?.outputDir || !isDesktop()}
            onClick={() =>
              void invoke('open_live_folder', { sessionId: sessionKey ?? null }).catch((e) => message.error(String(e)))
            }
          >
            打开会话目录
          </Button>
        }
      >
        <Table
          size="small"
          rowKey="path"
          pagination={false}
          dataSource={live?.recordingFiles ?? []}
          columns={[
            { title: '数据源', dataIndex: 'role', width: 150, render: (r: string) => roleNames[r] ?? r },
            {
              title: '文件名',
              dataIndex: 'name',
              ellipsis: true,
              render: (name: string, r) => (
                <Tooltip title={r.path}>
                  <span className="mono">{name}</span>
                </Tooltip>
              ),
            },
            { title: '文件大小', dataIndex: 'bytes', width: 150, render: formatBytes },
          ]}
          locale={{ emptyText: '接收到数据后显示录制文件' }}
        />
        <div className="chart-note">
          接收量与磁盘大小可能因写入缓冲暂时不同；正常停止会刷新文件。文件扩展名沿用 IPSClient
          规则，内容保持源流原始格式。文件按会话隔离，移除界面记录不会删除磁盘文件。
        </div>
      </Panel>
    </div>
  );
}
