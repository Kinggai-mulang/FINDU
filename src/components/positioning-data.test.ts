import { describe, it, expect } from 'vitest';
import type { Epoch } from '../../contracts';
import { epochXyz, projectEpochs, positionTooltip } from './positioning-data';
const epoch:Epoch={time:'2026-10-18T04:31:07.000Z',e:99,n:98,u:97,x:6378137,y:0,z:0,solution:'FIX',satellites:20};
describe('display origin and positioning labels',()=>{
  it('reprojects original XYZ, leaves source coordinates and statistics inputs untouched',()=>{
    const source=[epoch,{...epoch,x:6378138,y:2,z:3}];
    const values=projectEpochs(source,[6378137,0,0]);
    expect(values.map(e=>[e.e,e.n,e.u])).toEqual([[0,0,0],[2,3,1]]);
    expect(source.map(e=>e.e)).toEqual([99,99]);
    expect(projectEpochs(source,null)).toBe(source);
    expect(projectEpochs(source,[6378138,2,3])[1]).toMatchObject({e:0,n:0,u:0});
  });
  it('rejects missing, nonfinite and zero XYZ; does not mix coordinate frames',()=>{
    expect(epochXyz({...epoch,x:undefined})).toBeNull();expect(epochXyz({...epoch,y:NaN})).toBeNull();expect(epochXyz({...epoch,x:0,y:0,z:0})).toBeNull();
    expect(projectEpochs([epoch,{...epoch,x:undefined}],[6378137,0,0])).toHaveLength(1);
  });
  it('labels all overlay directions, deduplicates state boundary segments and escapes filenames',()=>{
    const values=['E','N','U'].map((axis,i)=>({value:[0,i,'FLOAT',epoch.time,axis,'<unsafe>','a']}));
    const text=positionTooltip([...values,values[0],{value:[null,null,'FIX',epoch.time,'E','b','b']}],false);
    expect(text).toContain('E <b>0.0000 m');expect(text).toContain('N <b>1.0000 m');expect(text).toContain('U <b>2.0000 m');expect(text).toContain('&lt;unsafe&gt;');expect(text.match(/FLOAT/g)).toHaveLength(3);expect(text).not.toContain('null');
    expect(positionTooltip(values[0],true)).toContain('E 0.0000 m · N 0.0000 m');
  });
});
