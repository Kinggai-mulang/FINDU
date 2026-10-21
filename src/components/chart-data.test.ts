import {describe,it,expect} from 'vitest';
import {coloredData,equalExtent,solutionColor} from './chart-data';
import type {Epoch} from '../../contracts';
const epoch=(solution:Epoch['solution'],e=0,n=0):Epoch=>({time:'2026-10-17T00:00:00Z',e,n,u:0,solution,satellites:12});
describe('positioning charts',()=>{
  it('groups FIX and HOLD without merging the original quality',()=>{
    expect(solutionColor('FIX')).toBe(solutionColor('HOLD'));
    expect(solutionColor('FLOAT')).not.toBe(solutionColor('FIX'));
    const epochs=[epoch('FIX'),epoch('HOLD'),epoch('FLOAT')];
    const data=coloredData(epochs,['FIX','HOLD'],e=>[e.e,e.n]);
    expect(data[0][2]).toBe('FIX');expect(data[1][2]).toBe('HOLD');expect(data[2][0]).toBeNull();
  });
  it('uses equal metres per pixel for a non-square EN plot',()=>{
    const bounds=equalExtent([epoch('FIX',-2,-1),epoch('FIX',2,5)],900,300);
    expect((bounds.maxX-bounds.minX)/900).toBeCloseTo((bounds.maxY-bounds.minY)/300,12);
    expect(bounds.minX).toBeLessThan(-2);expect(bounds.maxY).toBeGreaterThan(5);
  });
});
