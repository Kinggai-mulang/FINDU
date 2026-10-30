import { memo } from 'react';
import { CheckCircleOutlined } from '@ant-design/icons';
import { useEngine } from '../services/native-engine';

const activeStates = ['starting', 'running', 'stopping'];

/** Footer counters; re-renders only when sessions, tasks or results change. */
function StatusBar() {
  const sessions = useEngine((s) => s.realtimeSessions);
  const tasks = useEngine((s) => s.tasks);
  const results = useEngine((s) => s.results);
  const live = sessions?.filter((s) => activeStates.includes(s.state)).length ?? 0;
  const pending = tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  return (
    <footer className="statusbar">
      <div>
        <CheckCircleOutlined className="mint" /> 工作台就绪 <span className="status-divider" />{' '}
        {live ? `实时解算运行中 ${live} 路` : '数据流未运行'}
      </div>
      <div>
        待处理任务 {pending}
        <span className="status-divider" />
        结果集 {results.length}
        <span className="status-divider" />
        坐标单位 m · UTC
      </div>
    </footer>
  );
}
export default memo(StatusBar);
