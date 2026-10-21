import type {SolverConfig} from '../../contracts';
import {defaultConfig} from '../domain';
export const aliases:Record<string,string>={GNSS_SSRFile:'GNSS_ProductFile',GNSS_AllPreEphFile:'GNSS_SP3File',GNSS_AllPreClkFile:'GNSS_CLKFile',GNSS_ALLNavFile:'GNSS_NaviFile',GNSS_bOutputSessNMEA:'GNSS_bOutputSessionNMEA',GNSS_bOutputLog:'GNSS_bOutputLOG',GNSS_bOutputULOG:'GNSS_bOutputULog',GNSS_ULOGLevel:'GNSS_ULogLevel',GNSS_ULOGFileFilter:'GNSS_ULogFileFilter'};
export function parseOpt(text:string):Record<string,string>{const values:Record<string,string>={};for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){if(line.trim().startsWith('#'))continue;const match=line.match(/^\s*(\w+)\s*[=:]\s*([^;]*);/);if(match)values[aliases[match[1]]||match[1]]=match[2].trim();}return values;}
export function patchOpt(text:string,changes:Record<string,string>):string{
  for(const value of Object.values(changes))if(/[;\r\n]/.test(value))throw new Error('配置值不能包含分号或换行');
  const applied=new Set<string>();const newline=text.includes('\r\n')?'\r\n':'\n';
  const lines=text.split(/\r?\n/).map(line=>{
    if(line.trim().startsWith('#'))return line;
    const match=line.match(/^(\s*)(\w+)\s*[=:]\s*[^;]*;(.*)$/);if(!match)return line;
    const key=aliases[match[2]]||match[2];if(!(key in changes))return line;applied.add(key);return `${match[1]}${key} = ${changes[key]};${match[3]}`;
  });
  for(const [key,value]of Object.entries(changes))if(!applied.has(key))lines.push(`${key} = ${value};`);
  return lines.join(newline);
}
export function configFromOpt(text:string,name:string):SolverConfig{
  const v=parseOpt(text);const number=(key:string,fallback:number)=>v[key]!==undefined&&Number.isFinite(Number(v[key]))?Number(v[key]):fallback;return {...defaultConfig,name,mode:Number(v.GNSS_PMode)>=5?'RTK':Number(v.GNSS_PMode)>=2?'PPP':'SPP',elevationDeg:number('GNSS_ElevMask',10),intervalSec:number('GNSS_RoveSampleTime',1),systems:(['GPS','BDS','GAL','GLO']as const).filter(s=>!v.GNSS_SatSYS||v.GNSS_SatSYS.includes('SYS'+s)),productPath:v.GNSS_FilePath||''};
}
