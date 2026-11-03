import { describe, expect, it } from 'vitest';
import { distanceKm, parsePosition } from '../src/services/ntrip-geo';

describe('source table position helpers', () => {
  it('measures great-circle distances', () => {
    expect(distanceKm([30.5, 114.3], [30.5, 114.3])).toBe(0);
    // Wuhan to Beijing is about 1,055 km.
    expect(distanceKm([30.55, 114.3], [39.9, 116.4])).toBeGreaterThan(1030);
    expect(distanceKm([30.55, 114.3], [39.9, 116.4])).toBeLessThan(1080);
    // One degree of latitude is about 111 km.
    expect(distanceKm([0, 0], [1, 0])).toBeCloseTo(111.19, 0);
  });
  it('accepts latitude and longitude separated by comma, space or full-width comma', () => {
    expect(parsePosition('30.5, 114.3')).toEqual([30.5, 114.3]);
    expect(parsePosition('30.5 114.3')).toEqual([30.5, 114.3]);
    expect(parsePosition('30.5，114.3')).toEqual([30.5, 114.3]);
  });
  it('rejects incomplete or out-of-range positions', () => {
    expect(parsePosition('')).toBeNull();
    expect(parsePosition('30.5')).toBeNull();
    expect(parsePosition('95, 10')).toBeNull();
    expect(parsePosition('10, 200')).toBeNull();
    expect(parsePosition('a, b')).toBeNull();
  });
});
