import {App,Button,Input,Space,Tooltip} from 'antd';
import {CloseOutlined,FolderOpenOutlined,FileOutlined,InboxOutlined} from '@ant-design/icons';
import {invoke} from '@tauri-apps/api/core';
import {isDesktop,pickPath} from '../services/files';
import {useFileDrop} from '../services/file-drop';
import {isOptPath} from '../services/input-schema';

type Props={value?:string;onChange?:(value:string)=>void;field:string;label:string;hint?:string;directory?:boolean;disabled?:boolean;compact?:boolean};
export function PathInput({value='',onChange,field,label,hint,directory=false,disabled=false,compact=false}:Props){
 const {message}=App.useApp();
 const assign=async(path:string)=>{
  const checked=isDesktop()?await invoke<string>('validate_input_path',{path,role:directory?'directory':field}):path;
  onChange?.(checked);message.success(`已设置${label}`);
 };
 const {ref,dragging}=useFileDrop({accepts:p=>!isOptPath(p),onDrop:async paths=>assign(paths[0]),hint:`请拖入${label}${directory?'文件夹':'文件'}`,priority:100,enabled:!disabled});
 const name=value.replaceAll('\\','/').split('/').filter(Boolean).at(-1);
 return <div ref={ref} className={`path-control ${value?'has-value':''} ${dragging?'drag-active':''} ${disabled?'is-disabled':''} ${compact?'compact':''}`} data-file-role={field}>
  <div className="path-control-heading"><span className="path-file-icon">{directory?<FolderOpenOutlined/>:value?<FileOutlined/>:<InboxOutlined/>}</span><Tooltip title={value||hint}><span className="path-file-name">{name||`拖入${directory?'文件夹':'文件'}，或点击浏览`}</span></Tooltip>{value&&<span className="path-assigned">已填写</span>}</div>
  <Space.Compact block><Input aria-label={field} value={value} disabled={disabled} onChange={e=>onChange?.(e.target.value)} placeholder={hint||label}/><Tooltip title={`浏览${label}`}><Button aria-label={`选择 ${field}`} disabled={disabled||!isDesktop()} icon={<FolderOpenOutlined/>} onClick={async()=>{try{const p=await pickPath(directory);if(p)await assign(p);}catch(e){message.error(String(e));}}}/></Tooltip>{value&&<Tooltip title="清空路径"><Button aria-label={`清空 ${field}`} disabled={disabled} icon={<CloseOutlined/>} onClick={()=>onChange?.('')}/></Tooltip>}</Space.Compact>
  {dragging?<div className="path-drop-hint">松开以设置{label}</div>:!compact&&<div className="path-help">{hint||'支持拖放、浏览或粘贴完整路径'}</div>}
 </div>;
}
