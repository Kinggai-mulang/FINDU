import path from 'node:path';

export function assertEnginePair(windows, linux) {
  if (['commit', 'source_sha256', 'build_id'].some((key) => !windows[key] || windows[key] !== linux[key])) {
    throw new Error('Windows / Linux 引擎须来自同一源码构建，请先更新两份引擎清单');
  }
}

export function target(platform = process.platform, arch = process.arch) {
  if (arch !== 'x64' || !['win32', 'linux'].includes(platform))
    throw new Error('FINDU 当前支持 Windows x64 和 Linux x64');
  const windows = platform === 'win32';
  return {
    id: windows ? 'windows-x64' : 'linux-x64',
    application: windows ? 'FINDU.exe' : 'FINDU',
    binary: windows ? 'findyou.exe' : 'findyou',
    solver: windows ? 'IPSPOS.exe' : 'IPSPOS',
    client: windows ? 'IPSClient.exe' : 'IPSClient',
    python: windows ? 'python.exe' : 'bin/python3',
    engine: windows ? 'resources/engine' : 'resources/engine/linux-x64',
    runtime: windows ? 'resources/product-runtime' : 'resources/product-runtime-linux',
  };
}

export function outputDirectory(version, platform = target()) {
  const output = process.env.FINDYOU_PACKAGE_DIR ?? `deliverables/FINDU-${version}-${platform.id}`;
  const relative = path.relative(path.resolve('deliverables'), path.resolve(output));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('交付目录必须位于本工程 deliverables 的子目录内');
  return output;
}
