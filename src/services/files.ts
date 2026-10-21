export const isDesktop = () => '__TAURI_INTERNALS__' in window;
export async function pickPath(directory=false):Promise<string|null> {
  if(!isDesktop()) return null;
  const {open}=await import('@tauri-apps/plugin-dialog');
  const path=await open({directory,multiple:false,title:directory?'选择目录':'选择观测文件'});
  return typeof path==='string'?path:null;
}
export async function readJsonFile():Promise<string|null> {
  if(isDesktop()) {
    const {open}=await import('@tauri-apps/plugin-dialog');
    const path=await open({multiple:false,filters:[{name:'FINDU JSON 配置',extensions:['json']}]});
    if(typeof path!=='string')return null;
    const {readTextFile}=await import('@tauri-apps/plugin-fs');
    return readTextFile(path);
  }
  return new Promise((resolve,reject)=>{
    const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
    input.onchange=async()=>{try{resolve(input.files?.[0]?await input.files[0].text():null);}catch(e){reject(e);}};
    input.addEventListener('cancel',()=>resolve(null),{once:true});input.click();
  });
}
export async function exportText(name:string,text:string,mime='application/json'):Promise<boolean> {
  if(isDesktop()) {
    const {save}=await import('@tauri-apps/plugin-dialog');
    const {invoke}=await import('@tauri-apps/api/core');
    const paths=await invoke<{root:string}>('runtime_paths');
    const ext=name.split('.').pop()!;
    const path=await save({defaultPath:`${paths.root}\\exports\\${name}`,filters:[{name:ext.toUpperCase(),extensions:[ext]}]});
    if(!path)return false;
    const {writeTextFile}=await import('@tauri-apps/plugin-fs');await writeTextFile(path,text);return true;
  }
  const url=URL.createObjectURL(new Blob([text],{type:mime}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return true;
}
export async function exportPng(name:string,dataUrl:string):Promise<boolean>{
  if(isDesktop()){
    const {invoke}=await import('@tauri-apps/api/core');const {save}=await import('@tauri-apps/plugin-dialog');const paths=await invoke<{root:string}>('runtime_paths');const path=await save({defaultPath:`${paths.root}\\exports\\${name}`,filters:[{name:'PNG 图片',extensions:['png']}]});if(!path)return false;
    const {writeFile}=await import('@tauri-apps/plugin-fs');await writeFile(path,Uint8Array.from(atob(dataUrl.split(',')[1]),c=>c.charCodeAt(0)));return true;
  }
  const a=document.createElement('a');a.href=dataUrl;a.download=name;a.click();return true;
}
