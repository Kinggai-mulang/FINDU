import {useFileDrop} from './file-drop';
import {isObservationPath,isOptPath} from './input-schema';

export function useOptDrop(load:(paths:string[])=>void|Promise<void>,enabled=true,kind:'opt'|'observation'='opt'){
 return useFileDrop({onDrop:load,enabled,multiple:true,priority:kind==='opt'?10:5,
  accepts:kind==='opt'?isOptPath:isObservationPath,
  hint:kind==='opt'?'请在此区域拖入 .opt 配置文件':'请拖入 RINEX O 观测文件（支持 .gz）'});
}
