import { copyFile, mkdir, readFile, writeFile, cp, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { target, outputDirectory } from './platform.mjs';

const platform = target();
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const output = outputDirectory(version, platform);
const engineDir = process.env.FINDYOU_ENGINE_DIR ?? platform.engine;
const engine = JSON.parse(await readFile(path.join(engineDir, 'manifest.json'), 'utf8'));
if (
  engine.platform !== platform.id ||
  engine.protocols?.gnss_log !== 4 ||
  engine.protocols?.client_status !== 1 ||
  !engine.build_id
) {
  throw new Error(`打包需要 ${platform.id} 的 Log=4 / StatusLog=1 引擎及构建记录`);
}
for (const [name, key] of [
  [platform.solver, 'solver_sha256'],
  [platform.client, 'client_sha256'],
]) {
  const actual = createHash('sha256')
    .update(await readFile(path.join(engineDir, name)))
    .digest('hex');
  if (actual !== engine[key]) throw new Error(`${name} 与引擎清单的 SHA-256 不符`);
}
await mkdir(output, { recursive: true });
const release = process.env.CARGO_TARGET_DIR
  ? path.join(process.env.CARGO_TARGET_DIR, 'release')
  : 'src-tauri/target/release';
await copyFile(path.join(release, platform.binary), path.join(output, platform.application));
await mkdir(path.join(output, 'engine'), { recursive: true });
for (const file of [platform.solver, platform.client, 'manifest.json'])
  await copyFile(path.join(engineDir, file), path.join(output, 'engine', file));
for (const [source, name] of [
  ['resources/product-tools', 'product-tools'],
  [platform.runtime, 'product-runtime'],
]) {
  await cp(source, path.join(output, name), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (file) => !file.includes('__pycache__') && !/\.pyc$/i.test(file),
  });
}
if (process.platform === 'linux') {
  for (const file of [
    platform.application,
    `engine/${platform.solver}`,
    `engine/${platform.client}`,
    `product-runtime/${platform.python}`,
  ])
    await chmod(path.join(output, file), 0o755);
}
const python = path.resolve(output, 'product-runtime', platform.python);
execFileSync(
  python,
  [
    '-I',
    '-B',
    '-c',
    'import sys,ssl,socket,lzma,bz2,sqlite3,ctypes;sys.path.insert(0,sys.argv[1]);import findyou_products',
    path.resolve(output, 'product-tools'),
  ],
  { windowsHide: true, stdio: 'pipe' },
);
execFileSync(python, ['-I', '-B', 'scripts/engine-bundle.py', 'check', path.join(output, 'engine')], { stdio: 'pipe' });
await mkdir(path.join(output, 'engine-tools'), { recursive: true });
await copyFile('scripts/engine-bundle.py', path.join(output, 'engine-tools/engine-bundle.py'));
for (const [source, name] of [
  ['docs/ENGINE-UPDATE.md', '引擎更换说明.md'],
  [`docs/RELEASE-${version}.md`, '使用与版本说明.md'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  [`docs/VALIDATION-${version}.md`, `VALIDATION-${version}.md`],
])
  await copyFile(source, path.join(output, name));
const binary = await readFile(path.join(output, platform.application));
const manifest = {
  name: 'FINDU',
  version,
  platform: platform.id,
  mode: 'ipspos',
  packagedAtUtc: new Date().toISOString(),
  file: platform.application,
  bytes: binary.length,
  sha256: createHash('sha256').update(binary).digest('hex'),
  engine: {
    buildId: engine.build_id,
    sourceSha256: engine.source_sha256,
    sourceModified: engine.source_modified,
    protocols: engine.protocols,
    commit: engine.commit,
    version: engine.ipspos_version,
    sha256: engine.solver_sha256,
    clientSha256: engine.client_sha256,
  },
  requires: [
    process.platform === 'win32' ? 'Microsoft Edge WebView2 Runtime' : 'WebKitGTK 4.1 / GTK 3 / xdg-utils',
    `engine/${platform.solver}`,
    `engine/${platform.client}`,
    'engine/manifest.json',
    'product-tools/findyou_products.py',
    `product-runtime/${platform.python}`,
  ],
  signed: false,
};
await writeFile(path.join(output, 'build-info.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync(process.execPath, ['scripts/package-check.mjs', output], { stdio: 'inherit' });
// Archive only program resources, never runtime histories or imported credentials.
const entries = [
  platform.application,
  'engine',
  'product-tools',
  'product-runtime',
  'engine-tools',
  '引擎更换说明.md',
  '使用与版本说明.md',
  'THIRD_PARTY_NOTICES.md',
  `VALIDATION-${version}.md`,
  'build-info.json',
];
const archive = `${output}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
if (process.platform === 'win32') {
  // Windows bsdtar writes Chinese entry names without a reliable ZIP UTF-8 flag.
  execFileSync(
    python,
    [
      '-I',
      '-B',
      '-c',
      `
import sys, zipfile
from pathlib import Path
root = Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], 'w', zipfile.ZIP_DEFLATED) as package:
    for name in sys.argv[3:]:
        entry = root / name
        for file in ([entry] if entry.is_file() else entry.rglob('*')):
            if file.is_file():
                package.write(file, root.name + '/' + file.relative_to(root).as_posix())
with zipfile.ZipFile(sys.argv[2]) as package:
    assert package.testzip() is None, 'ZIP CRC mismatch'
    for name in sys.argv[3:]:
        entry = root.name + '/' + name
        assert any(file == entry or file.startswith(entry + '/') for file in package.namelist()), name
`,
      path.resolve(output),
      path.resolve(archive),
      ...entries,
    ],
    { stdio: 'inherit' },
  );
} else {
  execFileSync(
    'tar',
    [
      '-z',
      '-cf',
      archive,
      '-C',
      path.dirname(output),
      '--',
      ...entries.map((file) => `${path.basename(output)}/${file}`),
    ],
    { stdio: 'inherit' },
  );
}
console.log(`Packaged ${platform.id}: ${path.resolve(output)} (${(binary.length / 1024 / 1024).toFixed(1)} MiB)`);
