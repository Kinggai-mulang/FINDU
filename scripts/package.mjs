import { copyFile, mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const version=JSON.parse(await readFile('package.json','utf8')).version;
const output=process.env.FINDYOU_PACKAGE_DIR??`deliverables/FINDU-${version}-windows-x64`; 
const engineDir=process.env.FINDYOU_ENGINE_DIR??'resources/engine';
const engine=JSON.parse(await readFile(path.join(engineDir,'manifest.json'),'utf8'));
if(engine.protocols?.gnss_log!==4||engine.protocols?.client_status!==1||!engine.build_id)throw new Error('打包需要最新 Log=4 / StatusLog=1 引擎及构建记录');
for(const [name,key] of [['IPSPOS.exe','solver_sha256'],['IPSClient.exe','client_sha256']]){
 const actual=createHash('sha256').update(await readFile(path.join(engineDir,name))).digest('hex');
 if(actual!==engine[key])throw new Error(`${name} 与引擎清单的 SHA-256 不符`);
}
const relative=path.relative(path.resolve('deliverables'),path.resolve(output));
if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('交付目录必须位于本工程 deliverables 内');
await mkdir(output,{recursive:true});
await copyFile('src-tauri/target/release/findyou.exe',path.join(output,'FINDU.exe'));
await mkdir(path.join(output,'engine'),{recursive:true});
for(const file of ['IPSPOS.exe','IPSClient.exe','manifest.json'])await copyFile(path.join(engineDir,file),path.join(output,'engine',file));
for(const name of ['product-tools','product-runtime'])await cp('resources/'+name,path.join(output,name),{recursive:true,filter:source=>!source.includes('__pycache__')&&!/\.pyc$/i.test(source)});
// A clean checkout must include native Python extensions (.pyd), not just python.exe.
execFileSync(path.resolve(output,'product-runtime/python.exe'),['-I','-B','-c',
 'import sys,ssl,socket,lzma,bz2,sqlite3,ctypes;sys.path.insert(0,sys.argv[1]);import findyou_products',
 path.resolve(output,'product-tools')],{windowsHide:true,stdio:'pipe'});
await mkdir(path.join(output,'engine-tools'),{recursive:true});
await copyFile('scripts/engine-bundle.py',path.join(output,'engine-tools/engine-bundle.py'));
for(const [source,dest] of [['docs/ENGINE-UPDATE.md','引擎更换说明.md'],[`docs/RELEASE-${version}.md`,'使用与版本说明.md'],['THIRD_PARTY_NOTICES.md','THIRD_PARTY_NOTICES.md']])await copyFile(source,path.join(output,dest));
const binary=await readFile(path.join(output,'FINDU.exe'));
const manifest={name:'FINDU',version,platform:'windows-x64',mode:'ipspos',packagedAtUtc:new Date().toISOString(),file:'FINDU.exe',bytes:binary.length,sha256:createHash('sha256').update(binary).digest('hex'),engine:{buildId:engine.build_id,sourceSha256:engine.source_sha256,sourceModified:engine.source_modified,protocols:engine.protocols,commit:engine.commit,version:engine.ipspos_version,sha256:engine.solver_sha256,clientSha256:engine.client_sha256},requires:['Microsoft Edge WebView2 Runtime','engine/IPSPOS.exe','engine/IPSClient.exe','engine/manifest.json','product-tools/findyou_products.py','product-tools/atomic_io.py','product-tools/antenna_cache.py','product-runtime/python.exe'],signed:false};
await writeFile(path.join(output,'build-info.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Packaged FINDU.exe (${(binary.length/1024/1024).toFixed(1)} MiB)`);



