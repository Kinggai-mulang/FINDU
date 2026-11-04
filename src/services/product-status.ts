import type { ProductRecord } from '../../contracts/products';

export const productBusy = (record: ProductRecord) =>
  [record.job.status, record.dcb?.status].some((status) => status === 'queued' || status === 'running');

export function productStatus(record: ProductRecord): {
  type: 'info' | 'warning' | 'success';
  title: string;
  detail: string;
} {
  const ready = record.manifest?.results.filter((result) => result.status === 'ready' && result.opt) ?? [];
  if (!ready.length) {
    if (record.job.status === 'queued' || record.job.status === 'running')
      return { type: 'info', title: '正在准备主产品', detail: '识别观测时段后下载并校验；候选文件数不是下载进度。' };
    return {
      type: 'warning',
      title: '尚无可用配置',
      detail: '展开文件状态查看缺项。网络失败可重试；未发布产品可换快速等级；认证失败需配置数据源访问权限。',
    };
  }
  if (record.dcb?.status === 'queued' || record.dcb?.status === 'running')
    return {
      type: 'info',
      title: '主配置可用 · DCB 仍在准备',
      detail: '可先使用主配置。需要 DCB 时请等检查结束再送入后处理；已导入的配置不会自动更新。',
    };
  if (ready.some((result) => result.preparationLevel === 'basic') || record.dcb?.status === 'unavailable')
    return {
      type: 'warning',
      title: '配置可用 · 存在缺项',
      detail: '可继续解算；缺失产品对应的改正或固定能力可能不可用，请查看下方缺项。DCB 可单独重试。',
    };
  const unconfirmed =
    record.dcb?.updateStatus === 'fallback' ||
    record.dcb?.updateStatus === 'offline' ||
    Object.values(record.progress?.transfers ?? {}).some(
      (transfer) => transfer.antenna && !transfer.antenna.explicit && !transfer.antenna.versionChecked,
    );
  if (unconfirmed)
    return {
      type: 'warning',
      title: '配置可用 · 产品版本未联网确认',
      detail: '正在使用通过校验的本地或缓存产品；恢复联网后可重试检查。有效期合格不代表版本最新。',
    };
  return {
    type: 'success',
    title: '配置可用',
    detail: '已通过配套检查，可送入后处理。指定本地文件保持固定版本；来源与有效期见下方。',
  };
}
