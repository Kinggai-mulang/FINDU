import capacity from '../contracts/capacity.json';
import { version } from '../package.json';
import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, ConfigProvider, Space, Splitter, Tag, Tooltip } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import {
  RadarChartOutlined,
  SettingOutlined,
  LineChartOutlined,
  ApartmentOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import type { OptDocument, EngineInfo } from '../contracts';
import { workbenchEngine as engine } from './services/native-engine';
import { readStored, writeStored } from './services/storage';
import { isDesktop } from './services/files';
import RealtimeWorkspace from './pages/RealtimeWorkspace';
import DataDownloads from './pages/DataDownloads';
import Analysis from './pages/Analysis';
import NativePostProcess from './pages/NativePostProcess';
import Console from './components/Console';
import StatusBar from './components/StatusBar';
import { antdThemeConfig } from './theme';
import mark from '../resources/mark.png';
import './styles.css';
import './native-styles.css';
import './configuration.css';

type Page = 'monitor' | 'post' | 'config' | 'analysis';
const navigation = [
  { id: 'monitor' as const, label: '实时监控', english: 'Monitor', icon: <RadarChartOutlined /> },
  { id: 'post' as const, label: '后处理', english: 'Processing', icon: <ApartmentOutlined /> },
  { id: 'config' as const, label: '数据与下载', english: 'Data & Products', icon: <SettingOutlined /> },
  { id: 'analysis' as const, label: '分析对比', english: 'Analysis', icon: <LineChartOutlined /> },
];

/** Application shell: navigation, page switching and layout. Pages subscribe to the engine data they need. */
function Workbench() {
  const [engineInfo, setEngineInfo] = useState<EngineInfo>();
  useEffect(() => {
    if (isDesktop())
      void engine
        .info()
        .then(setEngineInfo)
        .catch(() => setEngineInfo(undefined));
  }, []);
  const storedPage = readStored<string>('page', 'monitor');
  const [page, setPage] = useState<Page>(
    navigation.some((n) => n.id === storedPage) ? (storedPage as Page) : 'monitor',
  );
  useEffect(() => {
    engine.setAnalysisVisible(page === 'analysis');
    engine.setRealtimeVisible(page === 'monitor');
  }, [page]);
  const [nativeDocuments, setNativeDocuments] = useState<OptDocument[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    engine.setVisibleAnalysisResults(selected);
  }, [selected]);
  const [collapsed, setCollapsed] = useState(Boolean(readStored('consoleCollapsed', false)));
  const savedConsole = readStored<number>('consoleHeight', 170);
  const initialConsole = Number.isFinite(savedConsole) ? Math.min(300, Math.max(110, savedConsole)) : 170;
  const { message } = AntApp.useApp();
  const persist = useCallback(
    (key: string, value: unknown) => {
      try {
        writeStored(key, value);
      } catch {
        message.warning('本地存储不可用，本次更改仅在当前会话保留');
      }
    },
    [message],
  );
  const navigate = useCallback(
    (p: Page) => {
      setPage(p);
      persist('page', p);
    },
    [persist],
  );
  const openResult = useCallback(
    (id: string) => {
      setSelected([id]);
      navigate('analysis');
    },
    [navigate],
  );
  const showResults = useCallback(
    (ids: string[]) => {
      setSelected(ids);
      navigate('analysis');
    },
    [navigate],
  );
  const collapse = useCallback(
    (next: boolean) => {
      setCollapsed(next);
      persist('consoleCollapsed', next);
    },
    [persist],
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate('monitor');
          }}
        >
          <img src={mark} />
          <div>
            <strong>FINDU</strong>
            <small>GNSS WORKBENCH</small>
          </div>
        </a>
        <div className="workspace-label">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav aria-label="主导航">
          {navigation.map((n) => (
            <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => navigate(n.id)}>
              {n.icon}
              <span>
                {n.label}
                <small>{n.english}</small>
              </span>
              {page === n.id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="engine-card">
            <div>
              <span className="engine-orb" />
              IPSPOS 引擎{' '}
              <Tooltip title={engineInfo?.buildId}>
                <Tag bordered={false}>{engineInfo?.version || (isDesktop() ? '未连接' : '界面预览')}</Tag>
              </Tooltip>
            </div>
            <p>{isDesktop() ? '实时 / 后处理 / 文件回放' : '浏览器界面预览'}</p>
            <small>
              实时最多 {capacity.realtimeRuns} 路 · 后处理最多 {capacity.postprocessRuns} 路
            </small>
          </div>
          <div className="sidebar-version">
            <span>FINDU {version}</span>
            <span>WINDOWS</span>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="breadcrumb">
            <DashboardOutlined />
            <span>工作台</span>
            <span className="slash">/</span>
            <strong>{navigation.find((n) => n.id === page)?.label}</strong>
          </div>
          <Space size={18}>
            <span className="runtime">
              <span className="tiny-dot" />
              {isDesktop() ? 'Windows 桌面' : '浏览器预览'}
            </span>
            {page === 'config' ? (
              <Tag color="blue">产品准备</Tag>
            ) : isDesktop() ? (
              <Tag color="green">IPSPOS 解算 / 分析</Tag>
            ) : (
              <Tag>界面预览 · 无引擎</Tag>
            )}
            <Tooltip title="桌面支持真实实时会话与后处理；浏览器仅预览界面">
              <span className="top-info">LOCAL WORKSPACE</span>
            </Tooltip>
          </Space>
        </header>
        <Splitter
          vertical
          className="workspace-split"
          onResizeEnd={(sizes) => {
            if (!collapsed) persist('consoleHeight', Math.round(sizes[1]));
          }}
        >
          <Splitter.Panel min={350}>
            <main className="workspace-content">
              {page === 'monitor' ? (
                <RealtimeWorkspace onResults={showResults} />
              ) : page === 'post' ? (
                <NativePostProcess
                  onResult={openResult}
                  documents={nativeDocuments}
                  setDocuments={setNativeDocuments}
                />
              ) : page === 'config' ? (
                <DataDownloads
                  onPrepared={(docs) => {
                    setNativeDocuments((prev) => [
                      ...docs,
                      ...prev.filter((p) => !docs.some((d) => p.sourcePath === d.sourcePath)),
                    ]);
                    navigate('post');
                  }}
                />
              ) : (
                <Analysis selected={selected} onSelected={setSelected} />
              )}
            </main>
          </Splitter.Panel>
          <Splitter.Panel
            defaultSize={initialConsole}
            min={collapsed ? 38 : 110}
            max={collapsed ? 38 : 360}
            size={collapsed ? 38 : undefined}
            resizable={!collapsed}
          >
            <Console collapsed={collapsed} onCollapse={collapse} onOpenResult={openResult} />
          </Splitter.Panel>
        </Splitter>
        <StatusBar />
      </div>
    </div>
  );
}
export default function App() {
  return (
    <ConfigProvider locale={zhCN} theme={antdThemeConfig}>
      <AntApp>
        <Workbench />
      </AntApp>
    </ConfigProvider>
  );
}
