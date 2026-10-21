import {describe,it,expect} from 'vitest';
import {fieldsForMode,dropTarget,isOptPath} from '../src/services/input-schema';
import {enuVelocity} from '../src/velocity';
import {geometryDiagnostics} from '../src/diagnostics';
import type {ResultSet} from '../contracts';
import {defaultConfig} from '../src/domain';

describe('mode-specific configuration and regional drop ownership',()=>{
 it('keeps PPP products out of all RTK modes and base observations out of PPP',()=>{
  for(const mode of ['6','7','8']){
   const keys=fieldsForMode(mode).map(f=>f.key);
   expect(keys).toContain('GNSS_BaseFile');
   for(const k of ['GNSS_SP3File','GNSS_CLKFile','GNSS_BIAFile','GNSS_ATXFile','GNSS_ProductFile','GNSS_BIASFile'])expect(keys).not.toContain(k);
  }
  expect(fieldsForMode('3').map(f=>f.key)).toContain('GNSS_SP3File');
  expect(fieldsForMode('2').map(f=>f.key)).not.toContain('GNSS_BaseFile');
 });
 it('routes one drop only, using physical pixels and the most specific compatible target',()=>{
  const rect={left:10,right:150,top:10,bottom:100};
  const opt={id:'opt',rect,priority:10,accepts:isOptPath};
  const base={id:'base',rect,priority:100,accepts:(p:string)=>!isOptPath(p)};
  const rover={id:'rover',rect:{...rect,left:200,right:300},priority:100,accepts:(p:string)=>!isOptPath(p)};
  expect(dropTarget([opt,base,rover],['station.26o'],{x:60,y:60},1.5)?.id).toBe('base');
  expect(dropTarget([opt,base],['a.opt','b.opt'],{x:60,y:60},1.5)?.id).toBe('opt');
  expect(dropTarget([opt,base],['station.26o'],{x:800,y:800},2)).toBeUndefined();
 });
});

describe('instantaneous ENU velocity, independent of display origin and position Q',()=>{
 it('uses the local ellipsoid basis, not a position subtraction or trajectory derivative',()=>{
  expect(enuVelocity([1,2,3],[6378137,0,0])).toEqual([2,3,1]);
  const at90=enuVelocity([1,2,3],[0,6378137,0])!;
  expect(at90[0]).toBeCloseTo(-1);expect(at90[1]).toBeCloseTo(3);expect(at90[2]).toBeCloseTo(2);
  for(const xyz of [[-2300000,4800000,3500000],[1,0,6356752]]){
   expect(Math.hypot(...enuVelocity([123.4,-56.7,8.9],xyz)!)).toBeCloseTo(Math.hypot(123.4,-56.7,8.9),10);
  }
 });
 it('preserves raw ECEF, rejects prediction, and retains speed if orientation is unavailable',()=>{
  const r:ResultSet={id:'v',name:'v',station:'v',source:'ipspos',config:defaultConfig,epochs:[],diagnostics:[
   {time:'2026-10-22T00:00:00Z',solution:'PRE',Q:3,VQ:2,X:6378137,Y:0,Z:0,VX:1,VY:2,VZ:3},
   {time:'2026-10-22T00:00:01Z',solution:'NONE',Q:0,VQ:3,X:null,Y:null,Z:null,VX:1,VY:2,VZ:3},
   {time:'2026-10-22T00:00:02Z',solution:'FIX',Q:7,VQ:1,X:6378137,Y:0,Z:0,VX:1,VY:2,VZ:3},
  ]};
  const rows=geometryDiagnostics(r).diagnostics!;
  expect(rows[0]).toMatchObject({VE:2,VN:3,VU:1,VX:1,VY:2,VZ:3});
  expect(rows[1]).toMatchObject({VE:null,VN:null,VU:null,Speed2D:null});
  expect(rows[1].Speed).toBeCloseTo(Math.sqrt(14));expect(rows[0].Speed2D).toBeCloseTo(Math.sqrt(13));
  expect(rows[2]).toMatchObject({VE:null,VN:null,VU:null,Speed:null});
  expect(r.diagnostics![0]).not.toHaveProperty('VE');
 });
});
