import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
const require=createRequire(import.meta.url);
// Avoid Windows .cmd argument quoting differences in package-manager runners.
const cli=require.resolve('@tauri-apps/cli/tauri.js');
const cargoBin=join(process.env.USERPROFILE||process.env.HOME||'', '.cargo','bin');
if(existsSync(join(cargoBin,process.platform==='win32'?'cargo.exe':'cargo')))process.env.PATH=`${cargoBin}${delimiter}${process.env.PATH||''}`;
const result=spawnSync(process.execPath,[cli,...process.argv.slice(2)],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
