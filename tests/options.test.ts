import {describe,it,expect} from 'vitest';
import {parseOpt,patchOpt,configFromOpt} from '../src/services/options';
import {statistics} from '../src/domain';
import {makeEpoch} from '../mock/data';

describe('真实 OPT 编辑',()=>{
  const text='# 保留注释\r\nGNSS_PMode = 2; # motion\r\nGNSS_SSRFile = product.rtcm3;\r\nGNSS_BIAFile = precise.bia;\r\nGNSS_BIASFile = stream.rtcm3;\r\nGNSS_Custom = 1.8e-12;\r\n';
  it('区分大小写近似键，别名取最后值',()=>{const v=parseOpt(text+'GNSS_ProductFile = new.rtcm3;');expect(v.GNSS_ProductFile).toBe('new.rtcm3');expect(v.GNSS_BIAFile).toBe('precise.bia');expect(v.GNSS_BIASFile).toBe('stream.rtcm3');});
  it('编辑文件不更改算法或未知参数，保留换行和注释',()=>{const patched=patchOpt(text,{GNSS_ProductFile:'D:\\a b\\p.rtcm3',GNSS_bOutputLOG:'ON'});expect(patched).toContain('GNSS_Custom = 1.8e-12;');expect(patched).toContain('GNSS_PMode = 2; # motion\r\n');expect(parseOpt(patched).GNSS_ProductFile).toBe('D:\\a b\\p.rtcm3');expect(patched).not.toContain('GNSS_SSRFile');});
  it('拒绝表单值注入额外配置行',()=>{expect(()=>patchOpt(text,{GNSS_RoveFile:'x;\nGNSS_ARMode=3;'})).toThrow();});
  it('从 OPT 生成可追溯的任务参数摘要',()=>{expect(configFromOpt(text+'GNSS_RoveSampleTime = 30;', 'sample').intervalSec).toBe(30);});
});
it('HOLD 计完整固定，部分固定 FLOFIX 单列',()=>{const e=makeEpoch(1,0,0);const result=statistics([{...e,solution:'FIX'},{...e,solution:'HOLD'},{...e,solution:'FLOFIX'},{...e,solution:'FLOAT'}]);expect(result.fixedRate).toBe(.5);});
