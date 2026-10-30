import { describe, expect, it } from 'vitest';
import { decimateIndices, FULL_DETAIL_LIMIT } from '../src/components/decimate';

const series = (n: number, f: (i: number) => number) => ({
  times: Array.from({ length: n }, (_, i) => i * 1000),
  values: Array.from({ length: n }, (_, i) => f(i)),
});

describe('decimateIndices', () => {
  it('keeps every point of a full realtime buffer', () => {
    const { times, values } = series(3600, Math.sin);
    expect(decimateIndices(times, values, 800)).toHaveLength(3600);
  });

  it('bounds long series by pixel columns and keeps spikes and endpoints', () => {
    const { times, values } = series(170000, (i) => (i === 123457 ? 50 : i === 98765 ? -40 : Math.sin(i / 500)));
    const picked = decimateIndices(times, values, 1000);
    expect(picked.length).toBeLessThanOrEqual(4 * 1000);
    expect(picked).toContain(123457);
    expect(picked).toContain(98765);
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(169999);
    expect(picked.every((v, i) => i === 0 || v > picked[i - 1])).toBe(true);
  });

  it('always keeps forced points such as solution changes', () => {
    const { times, values } = series(FULL_DETAIL_LIMIT * 4, () => 0);
    const forced = new Set([5001, 5002, 17777]);
    const picked = decimateIndices(times, values, 300, (i) => forced.has(i));
    for (const i of forced) expect(picked).toContain(i);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('tolerates missing values', () => {
    const { times, values } = series(20000, (i) => (i % 3 ? i : NaN));
    expect(decimateIndices(times, values, 100).length).toBeGreaterThan(0);
  });
});
