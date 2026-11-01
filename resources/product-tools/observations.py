"""Read observation metadata without decoding carrier/range measurements."""
import gzip
import hashlib
import re
import statistics
import json
import subprocess
import tempfile
import os
import shutil
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path


GPS0 = datetime(1980, 1, 6)
WEEK = timedelta(weeks=1)


class NeedsDate(ValueError):
    pass


def redate(metadata, day):
    """Move a summary decoded in the engine's fallback week to the GPS week of the user's GPST day."""
    start, end = (datetime.fromisoformat(metadata[k]) for k in ('start', 'end'))
    shifted = day - (day - GPS0) % WEEK + (start - GPS0) % WEEK
    if shifted - day > WEEK / 2:
        shifted -= WEEK
    elif day - shifted > WEEK / 2:
        shifted += WEEK
    metadata['start'] = shifted.isoformat(timespec='milliseconds')
    metadata['end'] = (shifted + (end - start)).isoformat(timespec='milliseconds')
    metadata['date_anchor'] = 'user'


def engine_path(path):
    """The native C file API accepts ANSI/short paths on Windows."""
    path = str(path)
    if os.name == 'nt' and not path.isascii():
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        if not ctypes.windll.kernel32.GetShortPathNameW(path, buffer, len(buffer)) or not buffer.value.isascii():
            raise ValueError('此观测路径无法转换为引擎可读路径，请放到英文路径后重试')
        path = buffer.value
    return path


def native_observation(path, repo, date):
    engine = Path(repo).parent / 'engine' / 'IPSPOS.exe'
    if not engine.is_file():
        raise ValueError('缺少支持模式 0 解码的 IPSPOS 引擎，请使用完整便携包')
    manifest = json.loads((engine.parent / 'manifest.json').read_text(encoding='utf-8-sig'))
    if manifest.get('capabilities', {}).get('observation_decode') != 2:
        raise ValueError('当前引擎尚不支持模式 0 观测解码')
    if date:
        datetime.strptime(date, '%Y-%m-%d')
    if any(c in str(path) for c in ';\r\n'):
        raise ValueError('观测路径含 OPT 分隔符')
    with tempfile.TemporaryDirectory(prefix='observation-') as folder:
        folder = Path(engine_path(folder))
        output = folder / 'observation.json'
        opt = folder / 'decode.opt'
        opt.write_text(f'GNSS_PMode = 0;\nGNSS_RoveFile = {engine_path(path)};\nGNSS_DecodeOutput = {output};\n', encoding='utf-8')
        with (folder/'decode.log').open('wb') as log:
            result = subprocess.run([str(engine), str(opt)], cwd=folder, stdin=subprocess.DEVNULL,
                                    stdout=log, stderr=subprocess.STDOUT,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode or not output.is_file():
            raise ValueError('原生解码未发现有效观测或时间线异常；纯 UBX RAWX、仅导航/产品流不支持')
        metadata = json.loads(output.read_text(encoding='utf-8'))
        if metadata.get('status') != 'ok' or not metadata.get('satellites'):
            raise ValueError('没有可用的原生观测历元')
        # "default": no ephemeris or receiver week in the stream, so the engine kept its fallback week.
        if metadata.get('date_anchor') == 'default':
            if not date:
                raise NeedsDate('观测流没有完整日期，请补充观测 GPST 日期后继续')
            redate(metadata, datetime.strptime(date, '%Y-%m-%d'))
        metadata['decoder_build_id'] = manifest['build_id']
        return metadata
SYSTEMS = {'G': 'GPS', 'C': 'BDS', 'E': 'Galileo', 'R': 'GLONASS', 'J': 'QZSS', 'S': 'SBAS', 'I': 'NavIC'}


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def calendar(parts):
    y, m, d, h, minute = map(int, parts[:5])
    if y < 100:
        y += 2000 if y < 80 else 1900
    return datetime(y, m, d, h, minute) + timedelta(seconds=float(parts[5]))


def gpst_shift(system, utc_offset):
    system = system.upper().strip()
    if system in ('GPS', 'GPST', 'GAL', 'GST', 'QZS', ''):
        return 0
    if system in ('BDT', 'BDS'):
        return 14
    if system in ('UTC', 'GLO') and utc_offset is not None:
        return utc_offset
    raise ValueError(f'时间系统 {system} 需要明确的 GPST−UTC 秒差；使用 --utc-offset')


def rinex(path, utc_offset=None):
    obs = defaultdict(set)
    svs = set()
    epochs = []
    first = last = previous = None
    deltas = []
    station = antenna = ''
    system = 'GPS'
    header_interval = None
    version = None
    current_system = ''
    opener = gzip.open if path.suffix.lower() == '.gz' else open
    with opener(path, 'rt', encoding='ascii', errors='replace') as f:
        for line in f:
            label = line[60:].strip()
            if label == 'RINEX VERSION / TYPE':
                version = float(line[:9])
                if line[20:21] != 'O':
                    raise ValueError('输入是 RINEX，但不是观测 O 文件')
            elif label == 'MARKER NAME':
                station = line[:60].strip()
            elif label == 'ANT # / TYPE':
                antenna = line[20:40].strip()
            elif label == 'TIME OF FIRST OBS':
                system = line[48:51].strip() or 'GPS'
            elif label == 'INTERVAL':
                header_interval = float(line[:10])
            elif label == 'SYS / # / OBS TYPES':
                current_system = line[0] if line[0] != ' ' else current_system
                obs[current_system].update(re.findall(r'[CLDS][0-9][A-Z]', line[7:60]))
            elif label == '# / TYPES OF OBSERV':
                obs['v2'].update(line[6:60].split())
            elif label == 'END OF HEADER':
                break
        if version is not None and version >= 4:
            raise ValueError('RINEX 4 尚未适配，请在独立目录转换为 RINEX 3')
        if version is None:
            raise ValueError('找不到 RINEX 观测头')
        shift = timedelta(seconds=gpst_shift(system, utc_offset))
        for line in f:
            t = None
            if version >= 3:
                if line.startswith('>'):
                    p = line[1:].split()
                    if len(p) >= 8 and int(p[6]) in (0, 1):
                        t = calendar(p[:6]) + shift
                elif re.match(r'^[GRECJSI]\d\d', line):
                    svs.add(line[:3])
            elif len(line) >= 32 and re.match(r'^ [ 0-9]\d [ 0-9]\d [ 0-9]\d', line):
                if line[28:29] in ('0', '1'):
                    t = calendar(line[:26].split()) + shift
                    n_sat = int(line[29:32])
                    identifiers = line[32:68].rstrip('\r\n').ljust(36)
                    for _ in range((n_sat + 11) // 12 - 1):
                        identifiers += next(f)[32:68].rstrip('\r\n').ljust(36)
                    for i in range(n_sat):
                        sv = identifiers[i * 3:i * 3 + 3]
                        if re.fullmatch(r'[GRECJSI]\d\d', sv):
                            svs.add(sv)
                        elif sv.strip().isdigit():
                            svs.add(f'G{int(sv):02d}')
                    n_obs = len(obs.get('v2', []))
                    if not n_obs:
                        raise ValueError('RINEX 2 缺少观测类型定义')
                    for _ in range(n_sat * ((n_obs + 4) // 5)):
                        next(f)
            if t is not None:
                first = min(first, t) if first else t
                last = max(last, t) if last else t
                if previous and 0 < (t - previous).total_seconds() < 3600 and len(deltas) < 20000:
                    deltas.append((t - previous).total_seconds())
                previous = t
                if len(epochs) < 2:
                    epochs.append(t)
    if not first:
        raise ValueError('RINEX 没有可用观测历元；不以文件名代替实际观测')
    systems = sorted({sv[0] for sv in svs})
    if 'v2' in obs:
        for s in systems:
            obs[s] = obs['v2'].copy()
        del obs['v2']
    return dict(format='RINEX', version=version, start=first.isoformat(), end=last.isoformat(),
                time_system='GPST', original_time_system=system, station=station, antenna=antenna,
                interval_s=statistics.median(deltas) if deltas else header_interval,
                systems=systems, satellites=sorted(svs), observables={s: sorted(v) for s, v in obs.items()},
                warnings=['RINEX 2 的信号跟踪属性未提供，AR 频点匹配需要进一步核查'] if version < 3 else [])


def inspect(path, repo, date=None, utc_offset=None):
    path = Path(path).resolve()
    before = path.stat()
    if not before.st_size:
        raise ValueError('观测文件为空')
    opener = gzip.open if path.suffix.lower() == '.gz' else open
    with opener(path, 'rb') as f:
        sample = f.read(4096)
    if b'COMPACT RINEX FORMAT' in sample:
        raise ValueError('输入为 Hatanaka 压缩观测，请先在独立目录用 FAST 的 crx2rnx 转换；不要覆盖原始文件')
    if b'RINEX VERSION / TYPE' in sample:
        result = rinex(path, utc_offset)
    else:
        if path.suffix.lower() == '.gz':
            with tempfile.TemporaryDirectory(prefix='raw-observation-') as folder:
                raw = Path(folder)/'observation.bin'
                with gzip.open(path,'rb') as source,raw.open('wb') as target:
                    shutil.copyfileobj(source,target,1024*1024)
                result = native_observation(raw, Path(repo), date)
        else:
            result = native_observation(path, Path(repo), date)
    result.update(path=str(path), size=before.st_size, sha256=sha(path), scanner_sha256=sha(Path(__file__)))
    if path.stat().st_mtime_ns != before.st_mtime_ns or path.stat().st_size != before.st_size:
        raise ValueError('识别过程中观测文件发生变化')
    return result
