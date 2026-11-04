import { describe, expect, it } from 'vitest';
import {
  classGroups,
  invertExcluded,
  parseSatellites,
  setExcluded,
  toggleExcluded,
} from '../src/services/satellite-select';

const all = [
  ...['C01', 'C02', 'C06', 'C11', 'C12', 'C16', 'C19', 'C20', 'C31', 'C38', 'C59'],
  ...['G01', 'G02', 'G13'],
  ...['E05', 'E31'],
];

describe('satellite ranges typed as text', () => {
  it('reads PRNs, ranges and whole systems in any separator', () => {
    expect(parseSatellites('C01-C02, G13', all).sats).toEqual(['C01', 'C02', 'G13']);
    expect(parseSatellites('c01~c12;e', all).sats).toEqual(['C01', 'C02', 'C06', 'C11', 'C12', 'E05', 'E31']);
    expect(parseSatellites('g1 g02', all).sats).toEqual(['G01', 'G02']);
    expect(parseSatellites('C12-C19', all).sats).toEqual(['C12', 'C16', 'C19']);
  });
  it('accepts a range written backwards and without the second letter', () => {
    expect(parseSatellites('C06-C01', all).sats).toEqual(['C01', 'C02', 'C06']);
    expect(parseSatellites('C19-20', all).sats).toEqual(['C19', 'C20']);
  });
  it('reports what matches nothing instead of ignoring it silently', () => {
    const { sats, unknown } = parseSatellites('C01, R05, C01-G05, hello', all);
    expect(sats).toEqual(['C01']);
    expect(unknown).toEqual(['R05', 'C01-G05', 'HELLO']);
    expect(parseSatellites('', all)).toEqual({ sats: [], unknown: [] });
  });
});

describe('satellite groups by orbit type', () => {
  // the numbers say nothing here: C38 is a medium orbit and C13 too, as the SP3 of the day shows
  const classes: Record<string, string> = {
    C01: 'GEO',
    C06: 'IGSO',
    C07: 'IGSO',
    C11: 'MEO',
    C13: 'MEO',
    C38: 'MEO',
    G01: 'MEO',
    G02: 'MEO',
    J01: 'IGSO',
    J02: 'IGSO',
    J07: 'GEO',
  };
  const sats = Object.keys(classes).concat('C20');
  it('uses the measured class and not the number', () => {
    const groups = classGroups('C', classes, sats);
    expect(groups.map((g) => g.key)).toEqual(['GEO', 'IGSO', 'MEO']);
    expect(groups[1].members).toEqual(['C06', 'C07']);
    expect(groups[2].members).toEqual(['C11', 'C13', 'C38']);
    expect(classGroups('J', classes, sats).map((g) => g.key)).toEqual(['GEO', 'IGSO']);
  });
  it('offers nothing for a system with one class, or without any measurement', () => {
    expect(classGroups('G', classes, sats)).toEqual([]);
    expect(classGroups('C', {}, sats)).toEqual([]);
  });
  it('keeps a single measured BeiDou class visible and leaves unknown satellites out', () => {
    expect(classGroups('C', { C01: 'MEO' }, ['C01', 'C59'])).toEqual([{ key: 'MEO', label: 'MEO', members: ['C01'] }]);
  });
  it('follows changed orbital classifications without a PRN generation rule', () => {
    expect(classGroups('C', { C01: 'MEO', C59: 'GEO' }, ['C01', 'C59'])).toEqual([
      { key: 'GEO', label: 'GEO', members: ['C59'] },
      { key: 'MEO', label: 'MEO', members: ['C01'] },
    ]);
  });
});

describe('exclusion lists', () => {
  it('adds and removes satellites and keeps the list sorted without repeats', () => {
    expect(setExcluded(['G02'], ['C01', 'G02', 'C02'], true)).toEqual(['C01', 'C02', 'G02']);
    expect(setExcluded(['C01', 'C02', 'G02'], ['C01', 'G13'], false)).toEqual(['C02', 'G02']);
  });
  it('a group button excludes everything first and restores only when all of it is already out', () => {
    const members = ['C01', 'C02', 'C06'];
    expect(toggleExcluded(['C01'], members)).toEqual(['C01', 'C02', 'C06']);
    expect(toggleExcluded(['C01', 'C02', 'C06', 'G01'], members)).toEqual(['G01']);
    expect(toggleExcluded([], [])).toEqual([]);
  });
  it('inverts only the given satellites and leaves the others alone', () => {
    expect(invertExcluded(['C01', 'G01'], ['C01', 'C02', 'C06'])).toEqual(['C02', 'C06', 'G01']);
  });
});
