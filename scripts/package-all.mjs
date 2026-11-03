import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertEnginePair } from './platform.mjs';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== 'win32') {
  throw new Error('双平台生成请使用 Windows + WSL 或双平台 CI；本机单平台使用 pnpm desktop:package:native');
}
const distro = process.env.FINDU_LINUX_DISTRO ?? 'FINDU-Build';
const windowsEngine = JSON.parse(readFileSync('resources/engine/manifest.json', 'utf8'));
const linuxEngine = JSON.parse(readFileSync('resources/engine/linux-x64/manifest.json', 'utf8'));
assertEnginePair(windowsEngine, linuxEngine);
const translated = spawnSync('wsl.exe', ['-d', distro, '--', 'wslpath', '-a', process.cwd().replaceAll('\\', '/')], {
  encoding: 'utf8',
});
if (translated.status !== 0) throw new Error(`Linux 构建环境 ${distro} 不可用，请参阅 README 的双平台构建说明`);
const repository = translated.stdout.trim();
run(process.execPath, ['scripts/tauri.mjs', 'build', '--no-bundle']);
run(process.execPath, ['scripts/package.mjs']);
run('wsl.exe', ['-d', distro, '--', 'bash', `${repository}/scripts/build-linux.sh`, repository]);
console.log('Windows / Linux packages completed.');
