"""Optional, bounded DSB preparation. Never changes primary product readiness."""
import gzip
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from atomic_io import dump, atomic_text
from dcb_validation import validate


def qualify(path, observation):
    if path.stat().st_size > 16*1024*1024:
        raise ValueError('DCB 超过 16 MiB')
    start = datetime.fromisoformat(observation['start'])
    end = datetime.fromisoformat(observation['end'])
    # Same-band relation used by the native SSR bridge; do not call OSB a DCB.
    required = []
    observables = observation.get('observables', {})
    for system, bands in [('G', [('1C','1W'),('2W','2X')])]:
        signals = {s[1:] for s in observables.get(system, []) if s.startswith('C')}
        for pair in bands:
            if signals & set(pair):
                required.append(dict(system=system, signals=list(pair), min_satellites=1))
    if not required:
        raise ValueError('当前观测没有已验证适用的 DCB 通道连接；保留基础产品配置')
    meta = validate(path, start.date(), 15, required)
    if datetime.fromisoformat(meta['hold_expiry_gpst']) <= end:
        raise ValueError('DCB 有效期及保持期限未覆盖整个观测时段')
    return meta


def attach(folder, path, metadata):
    manifest_path = folder/'work/manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    # Immutable content-addressed input. An already imported OPT remains a private text copy.
    for row in manifest.get('results', []):
        if row.get('status') != 'ready' or not row.get('opt'):
            continue
        opt = Path(row['opt'])
        text = opt.read_text(encoding='utf-8')
        lines = [line for line in text.splitlines() if line.split('=',1)[0].strip() not in ('GNSS_DCBFile','GNSS_bUseDCB','GNSS_DCBMaxHoldDays')]
        lines += [f'GNSS_DCBFile = {path};', 'GNSS_bUseDCB = ON;', 'GNSS_DCBMaxHoldDays = 15;']
        atomic_text(opt, '\n'.join(lines)+'\n')
        row.setdefault('products', {})['dcb'] = str(path)
    manifest['dcb'] = metadata
    dump(manifest_path, manifest)


def select_product(request, obs, cache, stage):
    """Prefer the newest causal DSB, retaining a qualified fallback on network failure."""
    errors = []
    local = [Path(request['dcbPath'])] if request.get('dcbPath') else []
    for root in [Path(request['observation']).parent, Path(request['localRoot']) if request.get('localRoot') else None]:
        if root and root.is_dir():
            local += [p for p in root.iterdir() if p.is_file() and p.suffix.lower() in ('.bia', '.bsx')]
    candidates = [(p, 'local') for p in dict.fromkeys(local)] + [(p, 'cache') for p in cache.glob('*.bia')]
    selected = None
    for path, origin in candidates:
        try:
            meta = qualify(path, obs)
            candidate = (path, origin, meta)
            # An explicit valid input is pinned for reproducible historical processing.
            if request.get('dcbPath') and path == Path(request['dcbPath']):
                return candidate, errors, 'pinned'
            if selected is None or meta['start_gpst_s'] > selected[2]['start_gpst_s']:
                selected = candidate
        except (ValueError, OSError, KeyError) as exc:
            errors.append(dict(source=str(path), message=str(exc)))
    if request.get('offline'):
        return selected, errors, 'offline'

    deadline = time.monotonic() + 45
    stage.mkdir(parents=True, exist_ok=True)
    day = datetime.fromisoformat(obs['start']).date()
    curl = 'curl.exe' if os.name == 'nt' else 'curl'

    def fetch(url, target):
        remaining = min(10, deadline - time.monotonic())
        if remaining <= 0:
            raise ValueError('DCB 更新检查已达到 45 秒时限')
        result = subprocess.run([curl, '--silent', '--show-error', '--fail', '--location',
                                 '--netrc-optional', '--connect-timeout', str(min(4, remaining)),
                                 '--max-time', str(remaining), '--max-filesize', str(16*1024*1024),
                                 '--output', str(target), url], stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, timeout=remaining + .1,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode:
            raise ValueError(f'下载失败 ({result.returncode})')

    # Listing avoids spending the entire budget probing days not yet published.
    listings = {}
    for year in dict.fromkeys((day.year, (day-timedelta(days=15)).year)):
        url = f'https://data.bdsmart.cn/pub/product/bias/{year}/'
        try:
            listing = stage / 'listing.html'
            fetch(url, listing)
            listings[year] = set(re.findall(r'CAS1OPSRAP_\d{11}_01D_01D_DCB\.BIA\.gz', listing.read_text(encoding='utf-8')))
        except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
            errors.append(dict(source=url, message=str(exc)))
    urls = []
    for offset in range(16):
        date = day - timedelta(days=offset)
        if selected and date.isoformat() < selected[2]['start_gpst'][:10]:
            break
        name = f'CAS1OPSRAP_{date.year}{date.timetuple().tm_yday:03}0000_01D_01D_DCB.BIA.gz'
        if date.year not in listings or name in listings[date.year]:
            urls.append(f'https://data.bdsmart.cn/pub/product/bias/{date.year}/{name}')
    if request.get('switchSource', True):
        for offset in range(16):
            date = day - timedelta(days=offset)
            if selected and date.isoformat() < selected[2]['start_gpst'][:10]:
                break
            for provider in ('CAS1', 'CAS0', 'GFZ0'):
                name = f'{provider}OPSRAP_{date.year}{date.timetuple().tm_yday:03}0000_01D_01D_DCB.BIA.gz'
                urls.append(f'ftp://igs.ign.fr/pub/igs/products/bias/{date.year}/{name}')
    for url in urls:
        if time.monotonic() >= deadline:
            break
        try:
            archive, plain = stage/'download.gz', stage/'candidate.bia'
            fetch(url, archive)
            with gzip.open(archive, 'rb') as stream:
                raw = stream.read(16*1024*1024+1)
            if len(raw) > 16*1024*1024:
                raise ValueError('DCB 超过 16 MiB')
            plain.write_bytes(raw)
            meta = qualify(plain, obs)
            if selected and meta['start_gpst_s'] < selected[2]['start_gpst_s']:
                continue
            meta['source'] = url
            return (plain, 'download', meta), errors, 'checked'
        except (OSError, ValueError, EOFError, subprocess.TimeoutExpired) as exc:
            errors.append(dict(source=url, message=str(exc)))
    return selected, errors, 'fallback'


def run(request_file):
    request_file = Path(request_file).resolve()
    folder = request_file.parent
    state = folder/'dcb.json'
    errors = []
    dump(state, dict(status='running'))
    try:
        request = json.loads(request_file.read_text(encoding='utf-8-sig'))
        plan = json.loads((folder/'work/plan.json').read_text(encoding='utf-8'))
        obs = plan['observation']
        cache = Path(request['cache'])/'dcb'
        cache.mkdir(parents=True, exist_ok=True)
        selected, errors, update_status = select_product(request, obs, cache, folder/'dcb-stage')
        if selected is None:
            dump(state,dict(status='unavailable',message='没有通过观测时段和通道校验的 DCB；可重试下载或指定匹配的本地文件。主配置仍可使用。',
                            checkedAt=datetime.now(timezone.utc).isoformat(),errors=errors[-20:]))
            return 0
        path,origin,meta=selected
        raw=path.read_bytes(); target=cache/(hashlib.sha256(raw).hexdigest()+'.bia')
        if not target.exists():
            temporary=target.with_suffix('.tmp');temporary.write_bytes(raw);temporary.replace(target)
        attach(folder,target,meta)
        dump(state,dict(status='ok',origin=origin,path=str(target),metadata=meta,errors=errors[-20:],
                        updateStatus=update_status, checkedAt=datetime.now(timezone.utc).isoformat()))
    except Exception as exc:
        dump(state,dict(status='unavailable',message=str(exc),errors=errors[-20:]))
    return 0
