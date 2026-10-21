import { describe, it, expect } from 'vitest';
import { canTransition, defaultConfig, parseConfig, statistics, validateConfig } from '../src/domain';
import { makeEpoch } from '../mock/data';

describe('配置边界',()=>{
  it('拒绝旧版、无效范围、空系统和非有限数值',()=>{
    expect(validateConfig(defaultConfig)).toEqual([]);
    for(const config of [{...defaultConfig,schemaVersion:2},{...defaultConfig,systems:[]},{...defaultConfig,intervalSec:0},{...defaultConfig,elevationDeg:NaN},{...defaultConfig,name:' '}])expect(validateConfig(config).length).toBeGreaterThan(0);
    expect(()=>parseConfig('{"schemaVersion":1}')).toThrow();
    expect(()=>parseConfig('broken')).toThrow();
  });
  it('导入只保留约定字段，输出可再次导入',()=>{
    expect(parseConfig(JSON.stringify({...defaultConfig,untrusted:true}))).toEqual(defaultConfig);
  });
});
describe('统计',()=>{
  it('从误差历元计算 RMS、固定率，排除无效坐标',()=>{
    const fixture=makeEpoch(0,0,0);
    const result=statistics([{...fixture,e:3,n:0,u:4,solution:'FIX'},{...fixture,e:0,n:4,u:0,solution:'FLOAT'},{...fixture,e:NaN,n:1,u:1}]);
    expect(result.rmsE).toBeCloseTo(Math.sqrt(4.5));expect(result.rmsN).toBeCloseTo(Math.sqrt(8));expect(result.rmsU).toBeCloseTo(Math.sqrt(8));expect(result.fixedRate).toBe(.5);expect(result.validEpochs).toBe(2);expect(result.totalEpochs).toBe(3);
    expect(statistics([])).toEqual({rmsE:0,rmsN:0,rmsU:0,fixedRate:0,validEpochs:0,totalEpochs:0});
  });
});
it('终态不能重新运行或取消',()=>{
  expect(canTransition('queued','running')).toBe(true);expect(canTransition('queued','succeeded')).toBe(false);
  for(const s of ['succeeded','failed','cancelled'] as const)expect(canTransition(s,'running')||canTransition(s,'cancelled')).toBe(false);
});
