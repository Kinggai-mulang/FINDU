import { describe, expect, it } from 'vitest';
import { mergeSlice, type Held } from '../src/services/live-buffers';

const held = (start: number, values: number[]): Held<{ v: number }> => ({
  start,
  end: start + values.length,
  items: values.map((v) => ({ v })),
});

describe('mergeSlice', () => {
  it('takes a full slice when nothing is held', () => {
    expect(mergeSlice(undefined, { start: 4, from: 4, end: 6, items: [{ v: 4 }, { v: 5 }] })).toEqual(held(4, [4, 5]));
  });

  it('appends after the resent last row and keeps identity when nothing changed', () => {
    const h = held(0, [0, 1, 2]);
    expect(mergeSlice(h, { start: 0, from: 2, end: 3, items: [{ v: 2 }] })).toBe(h);
    expect(
      mergeSlice(h, { start: 0, from: 2, end: 5, items: [{ v: 2 }, { v: 3 }, { v: 4 }] }).items.map((i) => i.v),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('replaces a last row rewritten in place, such as a refreshed product snapshot', () => {
    const merged = mergeSlice(held(0, [0, 1, 2]), { start: 0, from: 2, end: 3, items: [{ v: 20 }] });
    expect(merged.items.map((i) => i.v)).toEqual([0, 1, 20]);
  });

  it('drops rows that rolled out of the server buffer', () => {
    const merged = mergeSlice(held(0, [0, 1, 2, 3]), {
      start: 2,
      from: 3,
      end: 6,
      items: [{ v: 3 }, { v: 4 }, { v: 5 }],
    });
    expect(merged).toEqual(held(2, [2, 3, 4, 5]));
  });

  it('replaces everything when the client fell behind the server window', () => {
    const merged = mergeSlice(held(0, [0, 1]), { start: 10, from: 10, end: 12, items: [{ v: 10 }, { v: 11 }] });
    expect(merged).toEqual(held(10, [10, 11]));
  });
});
