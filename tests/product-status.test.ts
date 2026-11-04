import { describe, expect, it } from 'vitest';
import type { ProductRecord } from '../contracts/products';
import { productBusy, productStatus } from '../src/services/product-status';

const record = (patch: Partial<ProductRecord> = {}): ProductRecord => ({
  job: {
    id: 'one',
    name: 'one',
    status: 'ready',
    createdAt: '',
    directory: '',
    request: {} as ProductRecord['job']['request'],
  },
  manifest: { ready: true, results: [{ id: 'one', status: 'ready', opt: 'one.opt' }] },
  ...patch,
});
describe('product readiness and freshness are separate', () => {
  it('keeps optional DCB preparation visible after primary completion', () => {
    const value = record({ dcb: { status: 'running' } });
    expect(productBusy(value)).toBe(true);
    expect(productStatus(value).title).toContain('DCB 仍在准备');
  });
  it('does not present unavailable DCB as full readiness', () => {
    expect(productStatus(record({ dcb: { status: 'unavailable' } })).title).toBe('配置可用 · 存在缺项');
  });
  it('distinguishes checked products from fallback', () => {
    expect(productStatus(record({ dcb: { status: 'ok', updateStatus: 'fallback' } })).type).toBe('warning');
    expect(productStatus(record({ dcb: { status: 'ok', updateStatus: 'checked' } })).type).toBe('success');
  });
  it('does not call valid but unconfirmed antenna current', () => {
    const antenna = { frame: 'IGS20', sha256: 'abc', versionChecked: false, explicit: false };
    expect(productStatus(record({ progress: { transfers: { atx: { id: 'atx', status: 'ok', antenna } } } })).type).toBe(
      'warning',
    );
  });
  it('does not claim readiness without a generated OPT', () => {
    expect(productStatus(record({ manifest: { ready: false, results: [] } })).title).toBe('尚无可用配置');
  });
});
