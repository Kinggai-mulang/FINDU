"""Optional, bounded DSB preparation. Never changes primary product readiness."""
import gzip
import hashlib
import json
import os
import subprocess
import time
from datetime import datetime, timedelta
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
        local = [Path(request['dcbPath'])] if request.get('dcbPath') else []
        for root in [Path(request['observation']).parent, Path(request['localRoot']) if request.get('localRoot') else None]:
            if root and root.is_dir():
                local += [p for p in root.iterdir() if p.is_file() and p.suffix.lower() in ('.bia','.bsx')]
        candidates = [(p,'local') for p in dict.fromkeys(local)] + [(p,'cache') for p in sorted(cache.glob('*.bia'),key=lambda p:p.stat().st_mtime,reverse=True)]
        selected = None
        for path, origin in candidates:
            try:
                meta = qualify(path, obs)
                selected = (path,origin,meta)
                break
            except (ValueError,OSError,KeyError) as exc:
                errors.append(dict(source=str(path),message=str(exc)))
        if selected is None and not request.get('offline'):
            deadline = time.monotonic()+45
            day = datetime.fromisoformat(obs['start']).date()
            stage = folder/'dcb-stage'; stage.mkdir(exist_ok=True)
            for offset in range(16):
                if selected or time.monotonic()>=deadline: break
                date = day-timedelta(days=offset)
                for provider in ('CAS1','CAS0','GFZ'):
                    name = f'{provider}OPSRAP_{date.year}{date.timetuple().tm_yday:03}0000_01D_01D_DCB.BIA.gz'
                    urls = [f'https://data.bdsmart.cn/pub/product/bias/{date.year}/{name}'] if provider=='CAS1' else []
                    urls += [f'ftp://igs.ign.fr/pub/igs/products/bias/{date.year}/{name}']
                    if not request.get('switchSource',True): urls=urls[:1]
                    for url in urls:
                        remaining=deadline-time.monotonic()
                        if remaining<=0: break
                        archive=stage/'download.gz'; plain=stage/'candidate.bia'
                        try:
                            result=subprocess.run(['curl.exe' if os.name == 'nt' else 'curl','--silent','--show-error','--fail','--location','--netrc-optional','--connect-timeout',str(min(15,remaining)),'--max-time',str(min(15,remaining)),'--output',str(archive),url],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=min(15,remaining)+.1,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                            if result.returncode: raise ValueError(f'下载失败 ({result.returncode})')
                            with gzip.open(archive,'rb') as stream: raw=stream.read(16*1024*1024+1)
                            if len(raw)>16*1024*1024: raise ValueError('DCB 超过 16 MiB')
                            plain.write_bytes(raw)
                            meta=qualify(plain,obs);selected=(plain,'download',meta)
                            meta['source']=url
                            break
                        except (OSError,ValueError,EOFError,subprocess.TimeoutExpired) as exc:
                            errors.append(dict(source=url,message=str(exc)))
                    if selected: break
        if selected is None:
            dump(state,dict(status='unavailable',message='DCB 不可用；主产品和已生成 OPT 不受影响',errors=errors[-20:]))
            return 0
        path,origin,meta=selected
        raw=path.read_bytes(); target=cache/(hashlib.sha256(raw).hexdigest()+'.bia')
        if not target.exists():
            temporary=target.with_suffix('.tmp');temporary.write_bytes(raw);temporary.replace(target)
        attach(folder,target,meta)
        dump(state,dict(status='ok',origin=origin,path=str(target),metadata=meta,errors=errors[-20:]))
    except Exception as exc:
        dump(state,dict(status='unavailable',message=str(exc),errors=errors[-20:]))
    return 0
