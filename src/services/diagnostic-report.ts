import type {ResultSet} from '../../contracts';
import {chartSamples,fieldInfo,geometryDiagnostics,solverMode} from '../diagnostics';
import {fileColors} from '../components/chart-data';
import {format} from '../analysis';
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

/** Portable figures use the same raw fields and units as the UI; statistics remain full resolution. */
export function diagnosticFigures(results:ResultSet[],mode:'PPP'|'RTK'){
 const sources=results.map((r,i)=>({...r,color:fileColors[i%fileColors.length]})).filter(r=>solverMode(r)===mode).map(r=>({...geometryDiagnostics(r),color:r.color}));
 const fields=mode==='PPP'?['ZWD','TrpSRMS','IonDRMS','ZWDUCor','IAC50','IAC95']:['Com','DDS','BRAge','Baseline'];
 return fields.map(key=>{
  const info=fieldInfo[key]??{name:key,unit:'颗',scale:1};
  const data=sources.map(r=>({name:r.name,color:r.color,points:chartSamples(r.diagnostics??[],key,info.scale)}));
  const values=data.flatMap(r=>r.points.filter(p=>p[1]!==null));if(!values.length)return '';
  const lo=values.reduce((v,p)=>Math.min(v,p[1]!),Infinity),hi=values.reduce((v,p)=>Math.max(v,p[1]!),-Infinity);
  const first=values.reduce((v,p)=>Math.min(v,p[0]!),Infinity),last=values.reduce((v,p)=>Math.max(v,p[0]!),-Infinity);const span=Math.max(hi-lo,1e-6);
  const paths=data.map(r=>{
   const stride=Math.max(1,Math.ceil(r.points.length/1500));const picked:(number|null)[][]=[];
   for(let i=0;i<r.points.length;i+=stride){
    const block=r.points.slice(i,i+stride);if(block.some(p=>p[1]===null)){picked.push(...block);continue;}
    const extrema=[block[0],block.reduce((a,b)=>a[1]!<b[1]!?a:b),block.reduce((a,b)=>a[1]!>b[1]!?a:b),block.at(-1)!];
    picked.push(...[...new Set(extrema)].sort((a,b)=>a[0]!-b[0]!));
   }
   let drawing=false;let path='';for(const p of picked){if(p[1]===null){drawing=false;continue;}
    const x=90+(p[0]!-first)/Math.max(last-first,1)*860;const y=25+(hi+span*.05-p[1])/(span*1.1)*170;
    path+=`${drawing?'L':'M'}${x.toFixed(2)},${y.toFixed(2)} `;drawing=true;
   }
   return `<path d="${path}" stroke="${r.color}" stroke-width="1.3" fill="none"/>`;
  }).join('');
  return `<h3>${escape(info.name)} / ${escape(info.unit)}</h3><svg viewBox="0 0 1000 235" role="img" aria-label="${escape(info.name)}"><rect width="1000" height="235" fill="#f4f7fb"/><text x="4" y="30">${format(hi,4)}</text><text x="4" y="195">${format(lo,4)}</text>${paths}<text x="90" y="225">${new Date(first).toISOString()}</text><text x="720" y="225">${new Date(last).toISOString()}</text></svg><div class="legend">${data.map(r=>`<span style="color:${r.color}">${escape(r.name)}</span>`).join('')}</div>`;
 }).join('');
}
