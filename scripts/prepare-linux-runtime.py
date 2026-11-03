"""Install the pinned, independently runnable Linux Python used by portable packages."""
import hashlib
import json
import copy
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

NAME = 'cpython-3.12.16+20261026-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz'
URL = 'https://github.com/astral-sh/python-build-standalone/releases/download/20261026/' + NAME.replace('+', '%2B')
SHA256 = 'ce4f6d0a6cfdb3bed6e44c2f9affd85943c76a42e25ad3a259002f31d6fb8a20'


def runtime_member(member, directory):
    root = Path(directory).resolve()
    path = (root / member.name).resolve()
    if Path(member.name).is_absolute() or not path.is_relative_to(root):
        raise ValueError('Python archive path escapes staging directory')
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        raise ValueError('Python archive contains a special file')
    if member.issym() or member.islnk():
        link = (path.parent / member.linkname if member.issym() else root / member.linkname).resolve()
        if Path(member.linkname).is_absolute() or not link.is_relative_to(root):
            raise ValueError('Python archive link escapes staging directory')
        # Ubuntu's Python 3.10 data filter resolves symlinks from the archive root, not their parent.
        result = copy.copy(tarfile.tar_filter(member, directory))
        result.uid = result.gid = result.uname = result.gname = result.mode = None
        return result
    return tarfile.data_filter(member, directory)


def main():
    if sys.platform != 'linux':
        raise SystemExit('Run prepare-linux-runtime.py in the Linux build environment')
    root = Path(__file__).resolve().parents[1]
    target = root / 'resources/product-runtime-linux'
    if (target / 'bin/python3').is_file():
        manifest = json.loads((target / 'runtime-manifest.json').read_text(encoding='utf-8'))
        if manifest.get('sha256') != SHA256:
            raise ValueError('Cached Linux Python differs from the pinned runtime; replace the build cache first')
    if not (target / 'bin/python3').is_file():
        cache = root / 'runtime/downloads'
        cache.mkdir(parents=True, exist_ok=True)
        archive = cache / NAME
        if not archive.exists():
            with urllib.request.urlopen(URL, timeout=120) as source, archive.open('wb') as output:
                shutil.copyfileobj(source, output)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
            raise ValueError('Linux Python archive SHA-256 mismatch')
        with tempfile.TemporaryDirectory(prefix='findu-python-') as staging:
            staging = Path(staging)
            with tarfile.open(archive) as package:
                package.extractall(staging, filter=runtime_member)
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='.python-linux-', dir=target.parent) as ready:
                copied = Path(ready) / 'python'
                shutil.copytree(staging / 'python', copied, symlinks=True)
                copied.rename(target)
        (target / 'runtime-manifest.json').write_text(json.dumps({
            'python': '3.12.16', 'build': '20261026', 'platform': 'linux-x64',
            'archive': NAME, 'url': URL, 'sha256': SHA256,
        }, indent=2) + '\n', encoding='utf-8')
    subprocess.run([str(target / 'bin/python3'), '-I', '-B', '-c',
                    'import ssl,socket,lzma,bz2,sqlite3,ctypes; print("Linux Python runtime OK")'], check=True)


if __name__ == '__main__':
    main()
