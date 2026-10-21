import { Button, Select, Splitter, Tag } from 'antd';
import { CaretRightOutlined, PauseOutlined, EnvironmentOutlined, RadarChartOutlined } from '@ant-design/icons';
import type { EngineService, WorkbenchSnapshot } from '../../contracts';
import { stations } from '../../mock/data';
import { statistics, utcLabel } from '../domain';
import { EnuChart, SatelliteChart } from '../components/Charts';
import { Metric, NoData, PageHeading, Panel, SolutionTag } from '../components/common';

export default function Monitor({snapshot,service}:{snapshot:WorkbenchSnapshot;service:EngineService}) {
  const {live}=snapshot;const latest=live.epochs.at(-1);const stats=statistics(live.epochs);
  return <div className="page monitor-page">
    <PageHeading eyebrow="LIVE OBSERVATION" title="实时监控" description="观测测站状态、定位误差与卫星可用性。时间统一显示为 UTC。" actions={<><span className={`stream-state ${live.running?'active':''}`}><i/>{live.running?'模拟数据流运行中':'数据流已停止'}</span><Button type="primary" icon={live.running?<PauseOutlined/>:<CaretRightOutlined/>} onClick={()=>live.running?service.stopLive():service.startLive()}>{live.running?'停止模拟':'启动模拟'}</Button></>}/>
    <div className="monitor-split"><Splitter><Splitter.Panel defaultSize={235} min={210} max={320}>
      <Panel title="测站资源" extra={<span className="subtle">03</span>} className="station-panel">
        <div className="station-search"><Select aria-label="选择模拟测站" value={live.station} onChange={service.setStation} options={stations.map(s=>({value:s.id,label:s.name}))}/></div>
        {stations.map((s,i)=><button key={s.id} className={`station-item ${s.id===live.station?'selected':''}`} onClick={()=>{if(s.id!==live.station)service.setStation(s.id);}}><div className="station-icon"><EnvironmentOutlined/></div><div><strong>{s.id}</strong><small>{s.location}</small></div><span className={`station-dot ${s.id===live.station&&live.running?'on':''}`}/><span className="station-number">0{i+1}</span></button>)}
        <div className="station-info"><RadarChartOutlined/><strong>示例观测网络</strong><p>数据为本地生成的可复现样例。切换测站后需重新启动。</p><div><span>连接方式</span><Tag bordered={false}>本地模拟</Tag></div><div><span>刷新周期</span><span>1 秒</span></div><div><span>缓存窗口</span><span>600 历元</span></div></div>
      </Panel>
    </Splitter.Panel><Splitter.Panel min={550}>
      <div className="monitor-main">
        <div className="metrics metrics-four"><Metric label="当前解状态" value={latest?.solution||'—'} detail={latest?'最近历元 '+utcLabel(latest.time)+' UTC':'等待观测数据'} accent="#45d6b0"/><Metric label="可用卫星" value={latest?.satellites??'—'} unit="颗" detail="多系统联合观测"/><Metric label="水平 RMS" value={latest?Math.hypot(stats.rmsE,stats.rmsN).toFixed(3):'—'} unit="m" detail="当前缓存内模拟误差"/><Metric label="固定率" value={latest?(stats.fixedRate*100).toFixed(1):'—'} unit="%" detail={`${stats.validEpochs} 个有效历元`}/></div>
        <Panel title={<><span className="heading-dot"/>ENU 误差时间序列</>} extra={<span className="subtle">{live.station} · m · UTC</span>}>
          {latest?<EnuChart epochs={live.epochs} height={260}/>:<NoData/>}
        </Panel>
        <div className="monitor-lower"><Panel title="卫星可用性" extra={<Tag bordered={false}>GPS / BDS / GAL</Tag>}>{latest?<SatelliteChart epochs={live.epochs}/>:<NoData text="启动后显示卫星数量"/>}</Panel><Panel title="最新历元" extra={<SolutionTag value={latest?.solution}/>}><div className="epoch-values">{(['e','n','u'] as const).map((k,i)=><div key={k}><span>{['EAST','NORTH','UP'][i]}</span><strong style={{color:['#6aa8ff','#45d6b0','#ecb65c'][i]}}>{latest?latest[k].toFixed(4):'—'}<small> m</small></strong></div>)}</div><div className="epoch-footer">参考坐标系下的模拟误差 · 非实测位移</div></Panel></div>
      </div>
    </Splitter.Panel></Splitter></div>
  </div>;
}
