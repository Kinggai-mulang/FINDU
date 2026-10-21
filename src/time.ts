/** Explicit UTC dates keep multi-day charts unambiguous, including GPS week rollovers. */
export function utcAxisLabel(value:number):string {
 if(!Number.isFinite(value))return '—';
 const stamp=new Date(value).toISOString();
 return `${stamp.slice(5,10)}\n${stamp.slice(11,19)}`;
}

export function utcRangeSummary(start:number|undefined,end:number|undefined):string {
 if(start===undefined||end===undefined||!Number.isFinite(start)||!Number.isFinite(end)||end<start)return '';
 const first=new Date(start).toISOString(),last=new Date(end).toISOString();
 let seconds=Math.floor((end-start)/1000);
 const days=Math.floor(seconds/86400);seconds%=86400;
 const hours=Math.floor(seconds/3600);seconds%=3600;
 const minutes=Math.floor(seconds/60);seconds%=60;
 const dates=Math.floor(end/86400000)-Math.floor(start/86400000)+1;
 return `${first.slice(0,19).replace('T',' ')} — ${last.slice(0,19).replace('T',' ')} UTC · 跨度 ${days} 天 ${hours} 小时 ${minutes} 分 ${seconds} 秒 · 覆盖 ${dates} 个 UTC 日期`;
}
