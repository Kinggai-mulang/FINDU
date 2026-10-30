import { describe, it, expect } from 'vitest';
import { satelliteCounts, type Satellite } from '../src/services/satellites';
const sat = (prn: string, used: boolean | null, bands: string[]): Satellite => ({
  prn,
  system: prn[0] === 'G' ? 'GPS' : 'BDS',
  used,
  azimuth: null,
  elevation: null,
  signals: bands.map((band, slot) => ({ slot, band, signal: '1C', cn0: null, used })),
});
describe('latest satellite counts', () => {
  it('counts unique PRNs and each band once, retaining missing geometry/CN0', () => {
    const count = satelliteCounts([
      sat('G01', true, ['L1', 'L1', 'L2']),
      sat('C01', null, ['B1I']),
      sat('G01', true, ['L1', 'L2']),
    ]);
    expect(count.total).toBe(2);
    expect(count.used).toBe(1);
    expect(count.unknown).toBe(1);
    expect(count.bands).toHaveLength(3);
    expect(count.bands.every((r) => r.count === 1)).toBe(true);
  });
  it('a new empty epoch clears counts instead of retaining disappeared satellites', () => {
    expect(satelliteCounts([])).toEqual({ total: 0, used: 0, unknown: 0, bands: [] });
  });
});
