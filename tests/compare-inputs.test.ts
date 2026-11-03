import { describe, expect, it } from 'vitest';
import {
  addInputPaths,
  classifyInputPath,
  emptySet,
  problem,
  removeInputPath,
  testName,
  toBiasSet,
  toProductSet,
  without,
  type InputSet,
} from '../src/services/compare-inputs';

const set = (extra: Partial<InputSet> = {}): InputSet => ({ ...emptySet('x'), ...extra });

describe('input files', () => {
  it('tells bias, orbit and clock files apart, including IGS long names', () => {
    expect(classifyInputPath('D:\\p\\WUM0MGXFIN_20262620000_01D_01D_OSB.BIA')).toBe('bia');
    expect(classifyInputPath('/x/cas.bsx')).toBe('bia');
    expect(classifyInputPath('D:\\p\\WUM0MGXFIN_20262620000_01D_05M_ORB.SP3')).toBe('sp3');
    expect(classifyInputPath('/data/igs22000.sp3')).toBe('sp3');
    for (const name of ['a.clk', 'WUM0MGXFIN_20262620000_01D_30S_CLK.CLK', 'x.clk_30s', 'y.CLK_05S', 'z.clock'])
      expect(classifyInputPath(`D:\\p\\${name}`)).toBe('clk');
    for (const name of ['a.BIA.gz', 'orbit.sp3.gz', 'a.clk.Z']) expect(classifyInputPath(name)).toBe('compressed');
    expect(classifyInputPath('notes.txt')).toBeNull();
  });
  it('sorts a mixed drop into the three lists, each path once, and reports what it cannot use', () => {
    const { set: next, rejected } = addInputPaths(set({ bia: ['b.bia'] }), [
      'b.clk',
      'a.bia',
      'a.clk',
      'b.clk',
      'c.sp3',
      'b.bia',
      'bad.txt',
      'z.sp3.gz',
    ]);
    expect(next.bia).toEqual(['a.bia', 'b.bia']);
    expect(next.clk).toEqual(['a.clk', 'b.clk']);
    expect(next.sp3).toEqual(['c.sp3']);
    expect(rejected).toEqual(['bad.txt', 'z.sp3.gz']);
    expect(removeInputPath(next, 'a.clk').clk).toEqual(['b.clk']);
    expect(removeInputPath(next, 'c.sp3').sp3).toEqual([]);
    expect(removeInputPath(next, 'a.bia').bia).toEqual(['b.bia']);
  });
});

describe('one set for both comparisons', () => {
  const all = set({
    bia: ['r.bia'],
    clk: ['r.clk'],
    sp3: ['r.sp3'],
    apc: true,
    sign: 'invert',
  });
  it('hands each comparison the part it uses', () => {
    expect(toProductSet(all)).toEqual({ name: 'x', sp3: ['r.sp3'], clk: ['r.clk'], apc: true });
    expect(toBiasSet(all)).toEqual({
      name: 'x',
      files: ['r.bia'],
      clocks: ['r.clk'],
      orbits: ['r.sp3'],
      sign: 'invert',
    });
  });
  it('says what is missing for each comparison, and which products it leaves out', () => {
    const inputs = {
      reference: all,
      tests: [
        all,
        set({ name: '', bia: ['t.bia'] }),
        set({ name: ' ', sp3: ['t.sp3'] }),
        set({ name: 'CHC', clk: ['t.clk'] }),
      ],
    };
    expect(problem(inputs, 'sp3')).toBe('');
    expect(problem(inputs, 'bia')).toBe('');
    expect(without(inputs, 'sp3')).toEqual(['对比产品 2', 'CHC']);
    expect(without(inputs, 'bia')).toEqual(['对比产品 3', 'CHC']);
    expect(testName(inputs.tests[2], 2)).toBe('对比产品 3');
    expect(problem({ reference: set({ bia: ['r.bia'] }), tests: [all] }, 'sp3')).toBe('参考产品里还没有 SP3 轨道文件');
    expect(problem({ reference: all, tests: [set({ sp3: ['t.sp3'] })] }, 'bia')).toBe(
      '还没有带 BIA 偏差文件的对比产品',
    );
  });
});
