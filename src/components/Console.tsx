import { memo, useState } from 'react';
import { Button, Select, Tabs, Tag } from 'antd';
import { CodeOutlined, DownOutlined, UpOutlined } from '@ant-design/icons';
import type { Task } from '../../contracts';
import { useEngine, workbenchEngine } from '../services/native-engine';
import { statusColors, statusText, utcLabel } from '../domain';

/** Bottom dock with run logs and the post-processing queue; subscribes to logs, tasks and results only. */
function Console({
  collapsed,
  onCollapse,
  onOpenResult,
}: {
  collapsed: boolean;
  onCollapse: (collapsed: boolean) => void;
  onOpenResult: (id: string) => void;
}) {
  const allLogs = useEngine((s) => s.logs);
  const tasks = useEngine((s) => s.tasks);
  const results = useEngine((s) => s.results);
  const [tab, setTab] = useState('logs');
  const [filter, setFilter] = useState('all');
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  const logs = allLogs
    .filter((l) => filter === 'all' || (filter === 'errors' && l.level === 'error') || l.taskId === filter)
    .slice(-200)
    .reverse();
  const taskItem = (t: Task) => (
    <div className="console-task" key={t.id}>
      <Tag color={statusColors[t.status]}>{statusText[t.status]}</Tag>
      <span>{t.name}</span>
      <span className="mono">{t.progress}%</span>
      <span className="subtle">{t.error || t.request.config.mode}</span>
      {t.status === 'succeeded' ? (
        results.some((r) => r.id === t.resultId) ? (
          <Button type="link" size="small" onClick={() => onOpenResult(t.resultId!)}>
            查看结果
          </Button>
        ) : (
          <span className="subtle">缓存已清理</span>
        )
      ) : ['queued', 'running'].includes(t.status) ? (
        <Button type="link" size="small" danger onClick={() => workbenchEngine.cancelTask(t.id)}>
          取消
        </Button>
      ) : null}
    </div>
  );
  return (
    <section className={`console ${collapsed ? 'collapsed' : ''}`}>
      <div className="console-bar">
        <Tabs
          size="small"
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'logs',
              label: (
                <>
                  <CodeOutlined /> 运行日志 <span className="tab-count">{allLogs.length}</span>
                </>
              ),
            },
            {
              key: 'tasks',
              label: (
                <>
                  任务队列 <span className="tab-count">{running}</span>
                </>
              ),
            },
          ]}
        />
        <div className="console-controls">
          {tab === 'logs' && !collapsed && (
            <Select
              aria-label="筛选日志"
              size="small"
              value={filter}
              onChange={setFilter}
              style={{ width: 170 }}
              options={[
                { value: 'all', label: '全部日志' },
                { value: 'errors', label: '仅错误日志' },
                ...tasks.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          )}
          <span className="subtle">UTC</span>
          <Button
            size="small"
            type="text"
            aria-label={collapsed ? '展开日志面板' : '折叠日志面板'}
            icon={collapsed ? <UpOutlined /> : <DownOutlined />}
            onClick={() => onCollapse(!collapsed)}
          />
        </div>
      </div>
      {!collapsed && (
        <div className="console-content">
          {tab === 'logs' ? (
            logs.length ? (
              logs.map((l) => (
                <div className={`log-line ${l.level}`} key={l.id}>
                  <time>{utcLabel(l.time)}</time>
                  <span className="log-level">{l.level.toUpperCase()}</span>
                  <span>{l.message}</span>
                  {l.taskId && <span className="log-task">#{l.taskId.slice(0, 8)}</span>}
                </div>
              ))
            ) : (
              <div className="console-empty">没有匹配的日志</div>
            )
          ) : tasks.length ? (
            tasks.map(taskItem)
          ) : (
            <div className="console-empty">暂无任务，前往后处理导入 OPT 创建任务</div>
          )}
        </div>
      )}
    </section>
  );
}
export default memo(Console);
