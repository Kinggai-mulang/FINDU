"""Refresh and configure TEST auxiliary products without changing engine sources or credentials."""
import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT/'resources/product-tools'))
from atomic_io import dump
from optional_dcb import select_product
from transfer import Transfer


def values(text):
    return dict(re.findall(r'^\s*(\w+)\s*=\s*([^;\r\n]*);', text, re.M))


def configure(path, changes):
    original = path.read_bytes()
    text = original.decode('utf-8-sig')
    old = values(text)
    for key, value in changes.items():
        pattern = r'(^\s*'+re.escape(key)+r'\s*=\s*)[^;\r\n]*(;)'
        if re.search(pattern, text, re.M):
            text = re.sub(pattern, lambda m: m[1]+value+m[2], text, flags=re.M)
        else:
            text += f'\n{key} = {value};\n'
    # Record only product options: realtime OPTs contain credentials.
    changed = {key: old.get(key) for key, value in changes.items() if old.get(key) != value}
    if changed:
        backup = path.parent/'product-path-backups'/path.with_suffix('.json').name
        if not backup.exists():
            backup.parent.mkdir(exist_ok=True)
            dump(backup, changed)
        newline = '\r\n' if b'\r\n' in original else '\n'
        text = text.replace('\r\n', '\n').replace('\n', newline)
        # atomic_text uses platform text newlines; write bytes to preserve the OPT convention.
        temporary = path.with_suffix('.products.tmp')
        temporary.write_bytes((b'\xef\xbb\xbf' if original.startswith(b'\xef\xbb\xbf') else b'') + text.encode('utf-8'))
        temporary.replace(path)
    return list(changed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-root', type=Path, required=True)
    parser.add_argument('--cache', type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--configure', action='store_true')
    parser.add_argument('--compare-source', type=Path)
    args = parser.parse_args()
    root = args.test_root.resolve()
    if not (root/'RTIET').is_dir() or not (root/'POST').is_dir():
        parser.error('Expected TEST with RTIET and POST directories')
    cache = (args.cache or root/'DATA/PRODUCT_CACHE').resolve()
    cache.mkdir(parents=True, exist_ok=True)
    dcbs = cache/'dcb'; dcbs.mkdir(exist_ok=True)
    common = root/'DATA/COMMON'
    now = datetime.now(timezone.utc)
    report = dict(checkedAt=now.isoformat(), antenna={}, dcb={}, configs=[])
    transfer = Transfer(cache, [common], ROOT/'resources/product-tools/ThirdParty/FAST',
                        offline=args.offline, timeout=120, attempts=2)
    antenna = transfer.get(dict(id='igs20', kind='atx', required_frame='IGS20',
        urls=['https://files.igs.org/pub/station/general/igs20.atx.gz',
              'https://files.igs.org/pub/station/general/igs20.atx'],
        local_names=['antenna.atx', 'igs20.atx'],
        observation_window=[now.replace(tzinfo=None).isoformat(), (now+timedelta(days=1)).replace(tzinfo=None).isoformat()],
        observed_satellites=[f'G{i:02}' for i in range(1,33)]))
    report['antenna'] = {key: antenna[key] for key in ('status', 'path', 'origin', 'antenna', 'warnings', 'errors') if key in antenna}
    # Name-based offline fallback must also become an immutable input.
    if antenna['status'] == 'ok':
        raw = Path(antenna['path']).read_bytes()
        target = cache/('igs20-'+hashlib.sha256(raw).hexdigest()[:16]+'.atx')
        if not target.exists(): target.write_bytes(raw)
        antenna['path'] = str(target)
        report['antenna']['path'] = str(target)
    cases = {c['id']: c for c in json.loads((root/'cases.json').read_text(encoding='utf-8'))['cases']}
    failed = antenna['status'] != 'ok'
    for folder in ('RTIET', 'POST'):
        for opt in sorted((root/folder).glob('*.opt')):
            current = values(opt.read_text(encoding='utf-8-sig'))
            changes = {}
            if current.get('GNSS_ATXFile') and 'igs14' not in current['GNSS_ATXFile'].lower() and antenna['status'] == 'ok':
                changes['GNSS_ATXFile'] = str(Path(antenna['path']).relative_to(root)) if Path(antenna['path']).is_relative_to(root) else antenna['path']
                changes['GNSS_ATXFile'] = str(Path('..')/changes['GNSS_ATXFile']) if not Path(changes['GNSS_ATXFile']).is_absolute() else changes['GNSS_ATXFile']
            eligible = current.get('GNSS_bUseDCB', '').strip() == 'ON' if folder == 'RTIET' else (
                current.get('GNSS_ProductType', '').strip() == 'SSR' and bool(current.get('GNSS_ProductFile', '').strip())
                and current.get('GNSS_bUseDCB', '').strip() != 'OFF')
            if eligible:
                if folder == 'RTIET':
                    start, end = now.replace(tzinfo=None), (now+timedelta(days=1)).replace(tzinfo=None)
                    key = 'realtime'
                else:
                    match = re.search(r'(\d{8}T\d{4})-(\d{8}T\d{4})', cases[opt.stem]['dataset'])
                    if not match: raise ValueError('Cannot determine observation window: '+opt.name)
                    start, end = [datetime.strptime(s, '%Y%m%dT%H%M') for s in match.groups()]
                    key = start.date().isoformat()
                if key not in report['dcb']:
                    obs = dict(start=start.isoformat(), end=end.isoformat(), observables={'G':['C1C','C2W']})
                    request = dict(observation=str(common/'unused'), localRoot=str(common), offline=args.offline)
                    selected, errors, status = select_product(request, obs, dcbs, cache/('stage-'+key))
                    item = dict(updateStatus=status, errors=errors[-20:])
                    if selected:
                        path, origin, meta = selected
                        target = dcbs/(meta['sha256']+'.bia')
                        if not target.exists(): shutil.copyfile(path, target)
                        item.update(path=str(target), origin=origin, metadata=meta)
                    else:
                        failed = True
                    report['dcb'][key] = item
                item = report['dcb'][key]
                if item.get('path'):
                    changes.update(GNSS_DCBFile=item['path'], GNSS_bUseDCB='ON', GNSS_DCBMaxHoldDays='15')
            changed = configure(opt, changes) if args.configure else list(changes)
            report['configs'].append(dict(file=f'{folder}/{opt.name}', changed=changed))
    if args.compare_source:
        source = args.compare_source.resolve()
        destination = root/'PRODUCT_COMPARE'
        if source == destination or source in destination.parents:
            raise ValueError('Comparison source must be separate from destination')
        # Never overwrite an edited test input on repeated runs.
        for path in source.rglob('*'):
            if path.is_file():
                target = destination/path.relative_to(source)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists(): shutil.copy2(path, target)
        report['comparison'] = str(destination)
    dump(cache/'update-status.json', report)
    unconfirmed = not report['antenna'].get('antenna', {}).get('versionChecked', False) or any(
        item['updateStatus'] in ('fallback', 'offline') for item in report['dcb'].values())
    print(json.dumps(dict(status='incomplete' if failed else 'ready', report=str(cache/'update-status.json'),
                          message='产品缺失，请查看记录' if failed else ('产品可用，但部分版本未联网确认' if unconfirmed else '产品已校验，版本检查完成'),
                          changed=sum(bool(c['changed']) for c in report['configs'])), ensure_ascii=False))
    return 1 if failed else 0


if __name__ == '__main__':
    raise SystemExit(main())
