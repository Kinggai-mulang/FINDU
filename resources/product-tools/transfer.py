"""Bounded parallel transfers with persistent partials and validated local reuse."""
import gzip
import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit

from atomic_io import dump as atomic_dump
from observations import sha
import products_io
from products_io import product_info, frame_name, covers


class Transfer:
    def __init__(self, cache, roots, fast_root, offline=False, timeout=60, attempts=2):
        self.cache = Path(cache).resolve()
        self.cache.mkdir(parents=True, exist_ok=True)
        self.fast_root = Path(fast_root)
        self.offline, self.timeout, self.attempts = offline, timeout, attempts
        self.curl = shutil.which('curl.exe') or shutil.which('curl')
        if not self.curl and not offline:
            raise ValueError('需要 curl；Windows 自带 curl.exe，或安装 curl 后重试')
        self.index = {}
        self.lock = threading.Lock()
        self.hosts = {}
        self.results = {}
        # Search names only; never parse unrelated files or scan the whole repository by default.
        for root in dict.fromkeys([self.cache, *map(Path, roots)]):
            if not root.is_dir():
                continue
            for directory, dirs, files in os.walk(root):
                dirs[:] = [d for d in dirs if d not in ('.git', '__pycache__', '.partials', 'eph_cache', 'MYSQL', 'FAST')]
                for name in files:
                    if name.lower().endswith(('.sp3', '.clk', '.bia', '.bsx', '.rnx', '.nav', '.atx', '.gz', '.z')):
                        key = name.lower()
                        self.index.setdefault(key, []).append(Path(directory) / name)

    def metadata(self, path, kind):
        digest = sha(path)
        info_path = self.cache / 'checks' / (digest + '.' + kind + '.json')
        if info_path.is_file():
            try:
                meta = json.loads(info_path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                meta = {}
            if meta.get('sha256') == digest and meta.get('kind') == kind and meta.get('validator_sha256') == sha(products_io.__file__):
                return meta
        meta = product_info(path, kind)
        info_path.parent.mkdir(exist_ok=True)
        with self.lock:
            try:
                atomic_dump(info_path, meta)
            except OSError as exc:
                meta['cacheWarning'] = '校验缓存暂不可写，已使用本次文件实际校验结果：' + str(exc)
        return meta

    def unpack(self, source, name, target):
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + '.unpacking')
        try:
            if name.lower().endswith('.gz'):
                with gzip.open(source, 'rb') as f, temporary.open('wb') as out:
                    shutil.copyfileobj(f, out)
            elif name.endswith('.Z'):
                executable = next((p for p in [self.fast_root / 'src/fast/bin/gzip.exe', self.fast_root / 'src/win_bin/bin/gzip.exe'] if p.is_file()), None)
                executable = str(executable) if executable else shutil.which('gzip')
                if not executable:
                    raise ValueError('缺少 FAST gzip，无法解压 .Z')
                with temporary.open('wb') as out:
                    r = subprocess.run([executable, '-dc', str(source)], stdout=out, stderr=subprocess.PIPE, timeout=self.timeout)
                if r.returncode:
                    raise ValueError('.Z 解压失败')
            else:
                shutil.copy2(source, temporary)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def get(self, task):
        key = task['id']
        with self.lock:
            if key in self.results:
                return self.results[key]
        result = self._get(task)
        with self.lock:
            self.results[key] = result
        return result

    def _get(self, task):
        if task['kind'] == 'atx':
            from antenna_cache import fetch_antenna
            return fetch_antenna(self, task)
        return self._get_file(task)

    def validate_task(self, meta, task):
        if task.get('required_frame') and frame_name(meta['frame']) != task['required_frame']:
            raise ValueError('天线参考框架不匹配：' + str(meta['frame']) + ' / ' + task['required_frame'])
        window = task.get('observation_window')
        satellites = task.get('observed_satellites', [])
        if task['kind'] == 'atx' and window and satellites:
            start, end = map(datetime.fromisoformat, window)
            if not any(covers(meta['antenna_validity'].get(sv, []), start, end) for sv in satellites):
                raise ValueError('卫星天线标定有效期未覆盖所选观测；需更新 ANTEX，不能用接收机标定代替。')

    def _get_file(self, task):
        key = task['id']
        errors = []
        names = list(dict.fromkeys([*task.get('local_names', []), *[unquote(Path(urlsplit(u).path).name) for u in task['urls']]]))
        if task.get('_skip_local'):
            names = []
        for name in names:
            plain = name[:-3] if name.lower().endswith('.gz') else (name[:-2] if name.endswith('.Z') else name)
            for candidate in self.index.get(plain.lower(), []) + self.index.get(name.lower(), []):
                try:
                    if candidate.suffix.lower() in ('.gz', '.z'):
                        identity = sha(candidate) if task['kind'] == 'atx' else str(candidate)
                        target = self.cache / 'products' / hashlib.sha256(identity.encode()).hexdigest()[:16] / plain
                        if not target.is_file():
                            self.unpack(candidate, name, target)
                        meta = self.metadata(target, task['kind'])
                        path = target
                    else:
                        path = candidate
                        meta = self.metadata(path, task['kind'])
                    self.validate_task(meta, task)
                    return dict(id=task['id'], status='ok', origin='local', path=str(path), metadata=meta, errors=errors)
                except (OSError, ValueError, EOFError, subprocess.SubprocessError) as exc:
                    errors.append(dict(status='invalid', source=str(candidate), message=str(exc)))
        if self.offline or task.get('_local_only'):
            return dict(id=key, status='offline_miss', errors=errors)
        statuses = []
        for url in task['urls']:
            parsed = urlsplit(url)
            name = unquote(Path(parsed.path).name)
            if not name or name != Path(name).name or parsed.scheme not in ('http', 'https', 'ftp', 'ftps'):
                raise ValueError('下载地址或文件名无效')
            plain = name[:-3] if name.lower().endswith('.gz') else (name[:-2] if name.endswith('.Z') else name)
            digest = hashlib.sha256(url.encode()).hexdigest()[:24]
            folder = self.cache / '.partials' / digest
            folder.mkdir(parents=True, exist_ok=True)
            partial = folder / 'payload.part'
            target = self.cache / 'products' / digest / plain
            if task.get('_refresh'):
                # Immutable ANTEX snapshots: a newer version never changes an older OPT's input.
                target = self.cache / 'products' / digest / uuid.uuid4().hex[:12] / plain
            if target.is_file():
                try:
                    meta = self.metadata(target, task['kind'])
                    self.validate_task(meta, task)
                    return dict(id=key, status='ok', origin='cache', source=url, path=str(target), metadata=meta, errors=errors)
                except (OSError, ValueError):
                    # Keep suspect cached content for diagnosis, never overwrite a validated file.
                    target = target.with_name('retry_' + plain)
            with self.lock:
                semaphore = self.hosts.setdefault(parsed.hostname, threading.Semaphore(2))
            for attempt in range(self.attempts):
                args = [self.curl, '--silent', '--show-error', '--location', '--fail', '--netrc-optional',
                        '--connect-timeout', str(min(10, self.timeout)), '--max-time', str(self.timeout),
                        '--continue-at', '-', '--output', str(partial), '--write-out', '%{http_code}']
                actual_url = url
                if parsed.scheme == 'ftps':
                    # FAST uses explicit FTP-over-TLS, not implicit port 990.
                    actual_url = 'ftp' + url[4:]
                    args.append('--ssl-reqd')
                if parsed.scheme in ('ftp', 'ftps') and attempt == 0:
                    # HTTP proxies commonly reject FTP; try the archive directly first.
                    args.extend(['--noproxy', parsed.hostname or ''])
                previous = task.get('_previous', {})
                headers = folder / 'response.headers'
                if task['kind'] == 'atx':
                    args.extend(['--dump-header', str(headers)])
                    if previous.get('source') == url:
                        for field, name in [('etag', 'If-None-Match'), ('last_modified', 'If-Modified-Since')]:
                            value = previous.get(field)
                            if value and '\r' not in value and '\n' not in value:
                                args.extend(['--header', name + ': ' + value])
                args.append(actual_url)
                for resume_round in range(2):
                    with semaphore:
                        try:
                            r = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=self.timeout + 5)
                            code = r.stdout.decode('ascii', errors='ignore').strip()[-3:]
                        except subprocess.TimeoutExpired:
                            r, code = None, ''
                    if r is not None and (r.returncode == 33 or code == '416') and resume_round == 0:
                        partial.unlink(missing_ok=True)
                        continue
                    break
                if r is not None and r.returncode == 0:
                    try:
                        response = {}
                        if task['kind'] == 'atx' and headers.is_file():
                            for line in headers.read_text(encoding='iso-8859-1').splitlines():
                                if line.startswith('HTTP/'):
                                    response = {}
                                elif ':' in line:
                                    field, value = line.split(':', 1)
                                    if field.lower() in ('etag', 'last-modified'):
                                        response[field.lower().replace('-', '_')] = value.strip()
                        if code == '304':
                            if previous.get('source') != url or not previous.get('path'):
                                raise ValueError('服务器返回 304，但没有对应的可用天线缓存')
                            old = Path(previous['path'])
                            meta = self.metadata(old, task['kind'])
                            self.validate_task(meta, task)
                            if meta['sha256'] != previous['sha256']:
                                raise ValueError('天线缓存内容已改变，不能接受 304')
                            partial.unlink(missing_ok=True)
                            return dict(id=key, status='ok', origin='cache', source=url, path=str(old), metadata=meta,
                                        response={**{k: previous[k] for k in ('etag', 'last_modified') if k in previous}, **response},
                                        revalidated=True, errors=errors)
                        if not partial.is_file() or not partial.stat().st_size:
                            raise ValueError('服务器返回空文件')
                        self.unpack(partial, name, target)
                        meta = self.metadata(target, task['kind'])
                        self.validate_task(meta, task)
                        partial.unlink(missing_ok=True)
                        return dict(id=key, status='ok', origin='download', source=url, path=str(target), metadata=meta, errors=errors, **({'response': response} if task['kind'] == 'atx' else {}))
                    except (OSError, ValueError, EOFError, subprocess.SubprocessError) as exc:
                        statuses.append('invalid')
                        errors.append(dict(source=url, status='invalid', message=str(exc)))
                        partial.unlink(missing_ok=True)
                        if target.is_file():
                            rejected = self.cache / 'rejected' / digest / plain
                            rejected.parent.mkdir(parents=True, exist_ok=True)
                            os.replace(target, rejected)
                            errors[-1]['retained'] = str(rejected)
                        break
                status = 'network'
                if code in ('404', '410', '550') or (r is not None and r.returncode == 78):
                    status = 'missing'
                elif code in ('401', '403', '530') or (r is not None and r.returncode == 67):
                    status = 'authentication'
                # A server without Range support must be retried once from zero.
                if r is not None and (r.returncode == 33 or code == '416'):
                    partial.unlink(missing_ok=True)
                errors.append(dict(source=url, status=status, http_or_ftp=code, attempt=attempt + 1,
                                   message='认证失败：检查已有 netrc 配置' if status == 'authentication' else '未找到文件' if status == 'missing' else '连接/传输失败，可重新运行补下'))
                statuses.append(status)
                if status != 'network':
                    break
                if attempt + 1 < self.attempts:
                    time.sleep(min(2 ** attempt, 4))
        # An authoritative host can establish absence even when an optional mirror is offline.
        # Every filename variant offered by that primary host must have a definitive absence reply.
        primary = {}
        for u in task['urls']:
            host = urlsplit(u).hostname
            if host in task.get('primary_hosts', []):
                names = primary.setdefault(host, {})
                names.setdefault(Path(urlsplit(u).path).name, []).extend(e['status'] for e in errors if e.get('source') == u)
        confirmed = any(names and all(v and all(s == 'missing' for s in v) for v in names.values()) for names in primary.values())
        absent = bool(statuses) and all(s == 'missing' for s in statuses)
        if 'authentication' not in statuses and 'invalid' not in statuses and (confirmed or absent):
            status = 'missing'
        else:
            status = next((s for s in ('authentication', 'invalid', 'network') if s in statuses), 'unsupported')
        return dict(id=key, status=status, primary_absence_confirmed=confirmed, errors=errors)
