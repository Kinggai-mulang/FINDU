import {useEffect,useRef,useState} from 'react';
import {App} from 'antd';
import {isDesktop} from './files';
import {dropTarget} from './input-schema';

type Options={accepts:(path:string)=>boolean; onDrop:(paths:string[])=>void|Promise<void>; hint:string; priority?:number; enabled?:boolean; multiple?:boolean};
type Entry={element:()=>HTMLElement|null; options:()=>Options; highlight:(active:boolean)=>void; error:(text:string)=>void};
const zones=new Set<Entry>();
let release:(()=>void)|undefined;
let generation=0;
let paths:string[]=[];

function dispatch(type:string, position?:{x:number;y:number}, incoming?:string[]) {
  if(incoming)paths=incoming;
  const candidates=[...zones].flatMap(entry=>{
    const element=entry.element(),options=entry.options();
    return element&&options.enabled!==false&&element.getClientRects().length
      ?[{...entry,rect:element.getBoundingClientRect(),priority:options.priority??10,accepts:options.accepts}]:[];
  });
  const target=position?dropTarget(candidates,paths,position,window.devicePixelRatio||1):undefined;
  for(const zone of zones)zone.highlight(type!=='leave'&&type!=='drop'&&target?.highlight===zone.highlight&&paths.every(target.accepts));
  if(type==='drop'&&target){
    const options=target.options();
    if(!paths.every(options.accepts)){target.error(options.hint);return;}
    if(!options.multiple&&paths.length!==1){target.error('此区域一次接收一个文件或文件夹');return;}
    Promise.resolve(options.onDrop([...paths])).catch(e=>target.error(String(e)));
  }
  if(type==='drop'||type==='leave')paths=[];
}

function listen() {
  const own=++generation;
  void import('@tauri-apps/api/webview').then(({getCurrentWebview})=>getCurrentWebview().onDragDropEvent(({payload:e})=>{
    dispatch(e.type,'position' in e?e.position:undefined,'paths' in e?e.paths:undefined);
  })).then(fn=>{if(own!==generation||!zones.size)fn();else release=fn;}).catch(e=>{for(const z of zones)z.error('文件拖放未就绪：'+String(e));});
}

/** All path fields share a single native listener, with region-specific ownership. */
export function useFileDrop<T extends HTMLElement=HTMLDivElement>(options:Options) {
  const ref=useRef<T>(null),latest=useRef(options);latest.current=options;
  const [dragging,setDragging]=useState(false);const {message}=App.useApp();
  useEffect(()=>{
    if(!isDesktop())return;
    const entry:Entry={element:()=>ref.current,options:()=>latest.current,highlight:setDragging,error:text=>void message.warning(text)};
    zones.add(entry);if(zones.size===1)listen();
    return()=>{zones.delete(entry);if(!zones.size){generation++;release?.();release=undefined;paths=[];}};
  },[message]);
  return {ref,dragging};
}
