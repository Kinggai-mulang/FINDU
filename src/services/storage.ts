import type { SolverConfig } from '../../contracts';
import { defaultConfig, parseConfig } from '../domain';

export function readStored<T>(key:string,fallback:T):T { try {const raw=localStorage.getItem(`findyou.${key}`);return raw?JSON.parse(raw):fallback;}catch{return fallback;} }
export function writeStored(key:string,value:unknown) {localStorage.setItem(`findyou.${key}`,JSON.stringify(value));}
export function loadTemplates():SolverConfig[] {
  try {const data=readStored<unknown>('templates',[]);if(!Array.isArray(data))return [defaultConfig];const valid=data.flatMap(c=>{try{return [parseConfig(JSON.stringify(c))];}catch{return [];}});return valid.length?valid:[defaultConfig];}catch{return [defaultConfig];}
}
