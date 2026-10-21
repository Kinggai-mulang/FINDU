export function sessionName(file:string,ordinal:number){return `${String(ordinal).padStart(2,'0')}_${file.replace(/\.opt$/i,'')}`;}
export function nextOrdinal(names:string[]){return Math.max(0,...names.map(n=>Number(n.match(/^([0-9]+)_/)?.[1])||0))+1;}
export function compactSessionName(name:string,budget:number){const chars=Array.from(name);if(chars.length<=budget)return name;const tail=Math.max(3,Math.floor((budget-1)*.45));return chars.slice(0,budget-tail-1).join('')+'…'+chars.slice(-tail).join('');}
