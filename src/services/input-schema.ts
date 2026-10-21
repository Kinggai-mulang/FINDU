export const isRtkMode = (mode?: string) => ['6', '7', '8'].includes(mode ?? '');

export type FileField = {key: string; label: string; hint: string; group: 'observation'|'products'|'reference'|'advanced'; mode?: 'PPP'|'RTK'; directory?: boolean};
export const postFileFields: FileField[] = [
  {key:'GNSS_RoveFile', label:'流动站观测', hint:'拖入 RINEX O 或已录制的观测流', group:'observation'},
  {key:'GNSS_BaseFile', label:'基站观测', hint:'拖入基站 RINEX O 或观测流', group:'observation', mode:'RTK'},
  {key:'GNSS_NaviFile', label:'广播星历', hint:'导航 RINEX，支持混合星历', group:'observation'},
  {key:'GNSS_SP3File', label:'精密轨道', hint:'SP3 轨道文件', group:'products', mode:'PPP'},
  {key:'GNSS_CLKFile', label:'精密钟差', hint:'CLK 钟差文件', group:'products', mode:'PPP'},
  {key:'GNSS_BIAFile', label:'精密偏差', hint:'BIA / BSX 偏差文件', group:'products', mode:'PPP'},
  {key:'GNSS_ATXFile', label:'天线模型', hint:'ANTEX / ATX 文件', group:'products', mode:'PPP'},
  {key:'GNSS_RefFile', label:'参考文件', hint:'可选 REF，核对坐标框架与天线参考点', group:'reference'},
  {key:'GNSS_FilePath', label:'原输入根目录', hint:'导入 OPT 使用相对路径时的输入目录', group:'advanced', directory:true},
  {key:'GNSS_ProductFile', label:'产品回放流', hint:'SSR / B2b / HAS 录制文件', group:'advanced', mode:'PPP'},
  {key:'GNSS_BIASFile', label:'独立偏差回放流', hint:'独立 BIAS 录制文件', group:'advanced', mode:'PPP'},
];
export const fieldsForMode = (mode?: string) => postFileFields.filter(f => !f.mode || f.mode === (isRtkMode(mode) ? 'RTK' : 'PPP'));

export const isOptPath = (p: string) => /\.opt$/i.test(p);
export const isObservationPath = (p: string) => /\.(?:\d{2}o|o|obs|rnx)(?:\.gz)?$/i.test(p);

/** Hit testing uses CSS pixels, while Tauri reports physical pixels. Specific fields win. */
export function dropTarget<T extends {rect: {left:number;right:number;top:number;bottom:number}; priority:number; accepts:(p:string)=>boolean}>(
  targets: T[], paths:string[], position:{x:number;y:number}, scale=1,
): T | undefined {
  const x=position.x/scale, y=position.y/scale;
  const inside=targets.filter(t=>t.rect.right>t.rect.left&&t.rect.bottom>t.rect.top&&x>=t.rect.left&&x<=t.rect.right&&y>=t.rect.top&&y<=t.rect.bottom);
  return inside.filter(t=>paths.length&&paths.every(t.accepts)).sort((a,b)=>b.priority-a.priority)[0]
    ?? inside.sort((a,b)=>b.priority-a.priority)[0];
}
