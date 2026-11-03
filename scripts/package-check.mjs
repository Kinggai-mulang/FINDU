import { readFile, access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { target } from './platform.mjs';

const root = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('package-check.mjs PACKAGE_DIRECTORY');
const platform = target();
const manifest = JSON.parse(await readFile(path.join(root, 'build-info.json'), 'utf8'));
if (manifest.platform !== platform.id || manifest.file !== platform.application) throw new Error('程序平台不匹配');
const app = await readFile(path.join(root, platform.application));
if (createHash('sha256').update(app).digest('hex') !== manifest.sha256) throw new Error('程序 SHA-256 不匹配');
if (
  process.platform === 'linux' &&
  (app.subarray(0, 6).toString('hex') !== '7f454c460201' || app.readUInt16LE(18) !== 62)
)
  throw new Error('不是 Linux x64 ELF 程序');
for (const file of [
  platform.application,
  `engine/${platform.solver}`,
  `engine/${platform.client}`,
  `product-runtime/${platform.python}`,
]) {
  await access(path.join(root, file), process.platform === 'linux' ? constants.X_OK : constants.R_OK);
}
const python = path.join(root, 'product-runtime', platform.python);
if (process.platform === 'linux') {
  const info = await lstat(python);
  if (info.isSymbolicLink()) {
    const { realpath } = await import('node:fs/promises');
    if (!path.relative(root, await realpath(python)).startsWith('product-runtime/'))
      throw new Error('Python 软链接逃离便携包');
  }
}
execFileSync(python, ['-I', '-B', '-c', 'import ssl,socket,lzma,bz2,sqlite3,ctypes; print("bundled Python OK")'], {
  stdio: 'pipe',
});
execFileSync(
  python,
  ['-I', '-B', path.join(root, 'engine-tools/engine-bundle.py'), 'check', path.join(root, 'engine')],
  { stdio: 'pipe' },
);
console.log(
  JSON.stringify({
    version: manifest.version,
    platform: platform.id,
    sha256: manifest.sha256,
    engine: manifest.engine.buildId,
    result: 'passed',
  }),
);
