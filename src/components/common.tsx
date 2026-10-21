import { Alert, Empty, Tag } from 'antd';
import type { ReactNode } from 'react';

export function Panel({title,extra,children,className=''}:{title:ReactNode;extra?:ReactNode;children:ReactNode;className?:string}) {return <section className={`panel ${className}`}><div className="panel-heading"><h3>{title}</h3>{extra}</div>{children}</section>;}
export function Metric({label,value,unit,detail,accent}:{label:string;value:ReactNode;unit?:string;detail?:string;accent?:string}) {return <div className="metric"><div className="metric-label">{label}</div><div className="metric-value" style={{color:accent}}>{value}<span>{unit}</span></div><div className="metric-detail">{detail||'—'}</div></div>;}
export function PageHeading({eyebrow,title,description,actions}:{eyebrow:string;title:string;description:string;actions?:ReactNode}) {return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></div>;}
export function NoData({text='暂无数据，请先启动模拟数据流'}:{text?:string}) {return <div className="empty-state"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={text}/></div>;}
export function MockNote() {return <Alert type="info" showIcon title="模拟模式 · 当前数据仅用于工作流验证，不代表真实解算精度。" className="mock-note"/>;}
export function SolutionTag({value}:{value?:string}) {return <Tag color={value==='FIX'||value==='HOLD'?'success':value==='FLOAT'||value==='FLOFIX'?'warning':'default'}>{value||'等待数据'}</Tag>;}
