"""Check or replace FINDU's independent engine bundle. No source checkout is modified."""
import argparse
import ctypes
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

PLATFORMS = {'windows-x64': ('IPSPOS.exe', 'IPSClient.exe'), 'linux-x64': ('IPSPOS', 'IPSClient')}


def files(manifest):
    return (*PLATFORMS[manifest['platform']], 'manifest.json')
PROTOCOLS = {'gnss_log': 4, 'client_status': 1}
# Optional engine outputs this FINDU reads (docs/ENGINE-UPDATE.md): PMode=0 summary schema 2 and
# IPSClient_SatelliteFile with snapshot schema 2.
CAPABILITIES = {'observation_decode': 2, 'satellite_snapshot': 3}
# GNSS_DecodeFormat=SP3 (SSR to SP3/CLK) exists only in source trees that contain StreamConvert.c.
CONVERTER_SOURCE = 'src/IPSPOS/GNSSIO/StreamConvert.c'
CONVERTER_CAPABILITY = {'product_convert': 3}
SOURCE_SUFFIXES = {'.c', '.h', '.cpp', '.txt'}


def sha(path):
    with Path(path).open('rb') as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(131072), b''):
            digest.update(block)
        return digest.hexdigest()


def source_files(repo):
    files = [repo / 'CMakeLists.txt']
    files += [p for p in (repo / 'src').rglob('*') if p.is_file() and p.suffix.lower() in SOURCE_SUFFIXES]
    return sorted(files, key=lambda p: p.relative_to(repo).as_posix())


def source_sha(repo):
    """SHA-256 of sorted 'relative path NUL content NUL' over CMakeLists.txt and src C/C++ and .txt files."""
    digest = hashlib.sha256()
    for path in source_files(repo):
        digest.update(path.relative_to(repo).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()


def git(repo, *args):
    import subprocess
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, check=True).stdout.strip()


def pack(repo, output, platform=None):
    """Collect a Release build of an IPSPOS checkout into an engine directory with its manifest."""
    repo, output = Path(repo).resolve(), Path(output).resolve()
    platform = platform or ('windows-x64' if os.name == 'nt' else 'linux-x64')
    solver, client = PLATFORMS[platform]
    exes = {solver: repo / 'out/IPSPOS/Release' / solver, client: repo / 'out/IPSClient/Release' / client}
    newest = max(p.stat().st_mtime for p in source_files(repo))
    for name, exe in exes.items():
        if not exe.is_file() or exe.stat().st_mtime < newest:
            raise ValueError(f'{name} 缺失或早于源码修改，请先编译 Release')
    version = re.search(r'#define\s+IPSPOSVERSION\s+"([^"]+)"', (repo / 'src/IPSDLL/BASEDLL/BaseSDC.h').read_text(encoding='utf-8'))
    commit, source = git(repo, 'rev-parse', 'HEAD'), source_sha(repo)
    if output.exists() and any(output.iterdir()):
        raise ValueError('输出目录须为空')
    output.mkdir(parents=True, exist_ok=True)
    for name, exe in exes.items():
        shutil.copy2(exe, output / name)
    manifest = {'commit': commit, 'build_id': f'{commit[:12]}-source-{source[:16]}',
                'source_modified': bool(git(repo, 'status', '--porcelain', '--', 'CMakeLists.txt', 'src')),
                'source_sha256': source,
                'source_hash_method': 'SHA-256 of sorted source relative path NUL content NUL (CMakeLists.txt and src C/C++ headers/sources)',
                'ipspos_version': version[1], 'protocols': PROTOCOLS,
                'capabilities': {**CAPABILITIES, **(CONVERTER_CAPABILITY if (repo / CONVERTER_SOURCE).is_file() else {})},
                'built_at_utc': datetime.now(timezone.utc).isoformat(), 'platform': platform,
                'configuration': 'Release', 'solver_sha256': sha(output / solver),
                'client_sha256': sha(output / client)}
    atomic_json(output / 'manifest.json', manifest)
    return summary(check(output))


def check(directory):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8-sig'))
    if manifest.get('protocols') != PROTOCOLS:
        raise ValueError('需要 Log=4 / StatusLog=1；协议变化须先适配 FINDU')
    if not isinstance(manifest.get('build_id'), str) or not manifest['build_id'].strip():
        raise ValueError('缺少引擎 build_id')
    if not isinstance(manifest.get('ipspos_version'), str) or not manifest['ipspos_version'].strip():
        raise ValueError('缺少 IPSPOS 版本')
    if not re.fullmatch(r'[0-9a-fA-F]{64}', manifest.get('source_sha256', '')):
        raise ValueError('缺少可核验的源码 SHA-256')
    platform = manifest.get('platform', 'windows-x64')
    if platform not in PLATFORMS:
        raise ValueError('仅接受 Windows x64 或 Linux x64 引擎')
    manifest['platform'] = platform
    solver, client = PLATFORMS[platform]
    for key, name in [('solver_sha256', solver), ('client_sha256', client)]:
        exe = directory / name
        if not exe.is_file() or exe.is_symlink():
            raise ValueError(f'缺少独立文件：{name}')
        if manifest.get(key) != sha(exe):
            raise ValueError(f'{name} SHA-256 与 manifest 不符，不能只替换单个 EXE')
        with exe.open('rb') as stream:
            head = stream.read(64)
            if platform == 'linux-x64':
                if len(head) != 64 or head[:6] != b'\x7fELF\x02\x01' or struct.unpack_from('<H', head, 18)[0] != 62:
                    raise ValueError(f'{name} 不是 Linux x64 ELF 程序')
                if os.name != 'nt' and not os.access(exe, os.X_OK):
                    raise ValueError(f'{name} 缺少执行权限')
                continue
            if len(head) != 64 or head[:2] != b'MZ':
                raise ValueError(f'{name} 不是 Windows PE 程序')
            offset = struct.unpack_from('<I', head, 60)[0]
            if offset < 64 or offset > exe.stat().st_size - 6:
                raise ValueError(f'{name} PE 文件头无效')
            stream.seek(offset)
            if stream.read(6) != b'PE\0\0\x64\x86':
                raise ValueError(f'{name} 不是 Windows x64 程序')
    return manifest


def summary(manifest):
    return {'buildId': manifest['build_id'], 'sourceSha256': manifest['source_sha256'],
            'sourceModified': manifest.get('source_modified', False), 'protocols': manifest['protocols'],
            'commit': manifest.get('commit', ''), 'version': manifest['ipspos_version'],
            'sha256': manifest['solver_sha256'], 'clientSha256': manifest['client_sha256']}


def available(path):
    """An exclusive writable handle detects a running image without changing its bytes."""
    if os.name != 'nt' or not path.exists():
        return
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(str(path), 0xC0000000, 0, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ValueError(f'文件正在使用或不可写：{path.name}。请关闭该目录的 FINDU、IPSPOS、IPSClient 后重试')
    kernel.CloseHandle(handle)


def atomic_json(path, value):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def install(candidate, app):
    candidate, app = Path(candidate).resolve(), Path(app).resolve()
    manifest = check(candidate)
    names = ['FINDU.exe', 'FINDYOU.exe'] if manifest['platform'] == 'windows-x64' else ['FINDU']
    executable = next((app / name for name in names if (app / name).is_file()), None)
    if executable is None:
        raise ValueError('--app 必须是含对应平台 FINDU 程序的完整目录')
    if executable.is_symlink():
        raise ValueError('程序文件必须位于目标目录内')
    if (app / 'build-info.json').is_file():
        info = json.loads((app / 'build-info.json').read_text(encoding='utf-8-sig'))
        if info.get('platform', 'windows-x64') != manifest['platform']:
            raise ValueError('候选引擎与 FINDU 程序平台不匹配')
    target = app / 'engine'
    if target.is_symlink() or target.resolve().parent != app:
        raise ValueError('目标 engine 必须是程序目录下的独立目录')
    if candidate == target:
        raise ValueError('候选与目标是同一目录；检查使用 check 命令')
    previous = None
    try:
        previous = check(target)
    except (ValueError, OSError):
        pass  # A damaged old bundle can still be retained and replaced by a valid bundle.
    if previous and all(previous[k] == manifest[k] for k in ['build_id', 'solver_sha256', 'client_sha256']):
        return {'changed': False, 'engine': summary(manifest)}
    for path in [executable, *(target / name for name in PLATFORMS[manifest['platform']])]:
        available(path)
    info_path = app / 'build-info.json'
    if info_path.is_symlink() or not (app / 'runtime/engine-backups').resolve().is_relative_to(app):
        raise ValueError('更新记录与备份必须保存在目标程序目录内')
    info_bytes = info_path.read_bytes() if info_path.exists() else None
    info = json.loads(info_bytes.decode('utf-8-sig')) if info_bytes is not None else None
    if info is not None and info.get('sha256', sha(executable)) != sha(executable):
        raise ValueError('FINDU 程序与应用构建记录不一致，先核对目标程序目录')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    suffix = re.sub(r'[^A-Za-z0-9_.-]', '_', previous['build_id'] if previous else 'unverified')[:80]
    backup = app / 'runtime/engine-backups' / f'{stamp}-{suffix}-{uuid.uuid4().hex[:8]}'
    stage = app / ('.engine-stage-' + uuid.uuid4().hex)
    moved_old, installed = False, False
    try:
        stage.mkdir()
        for name in files(manifest):
            shutil.copy2(candidate / name, stage / name)
        if check(stage) != manifest:
            raise ValueError('候选引擎在复制期间发生变化，未替换目标引擎')
        backup.mkdir(parents=True)
        if info_bytes is not None:
            (backup / 'build-info.json').write_bytes(info_bytes)
        if target.exists():
            os.replace(target, backup / 'engine')
            moved_old = True
        os.replace(stage, target)
        installed = True
        if info is not None:
            info['engine'] = summary(manifest)
            info['engineUpdatedAtUtc'] = datetime.now(timezone.utc).isoformat()
            atomic_json(info_path, info)
        result = {'changed': True, 'engine': summary(manifest), 'backup': str(backup),
                  'applicationSha256': sha(executable), 'updatedAtUtc': datetime.now(timezone.utc).isoformat()}
        atomic_json(backup / 'update.json', result)
        return result
    except BaseException:
        if installed:
            os.replace(target, stage)
        if moved_old:
            os.replace(backup / 'engine', target)
        if installed and info_bytes is not None:
            info_path.write_bytes(info_bytes)
        raise
    finally:
        if stage.exists():
            assert stage.parent == app and stage.name.startswith('.engine-stage-')
            shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description='校验、备份并替换 FINDU 独立引擎，不改动算法源码或结果')
    sub = parser.add_subparsers(dest='command', required=True)
    verify = sub.add_parser('check'); verify.add_argument('engine')
    update = sub.add_parser('install'); update.add_argument('engine'); update.add_argument('--app', required=True)
    build = sub.add_parser('pack', help='由已编译的 IPSPOS 仓库生成候选 engine 目录')
    build.add_argument('repo'); build.add_argument('output'); build.add_argument('--platform', choices=list(PLATFORMS))
    args = parser.parse_args()
    try:
        if args.command == 'check':
            result = summary(check(args.engine))
        elif args.command == 'install':
            result = install(args.engine, args.app)
        else:
            result = pack(args.repo, args.output, args.platform)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError) as error:
        parser.exit(1, f'引擎操作未完成：{error}\n')


if __name__ == '__main__':
    main()
