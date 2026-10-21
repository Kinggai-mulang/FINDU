"""Read observation metadata without decoding carrier/range measurements."""
import gzip
import hashlib
import mmap
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

GPS0 = datetime(1980, 1, 6)
SYSTEMS = {'G': 'GPS', 'C': 'BDS', 'E': 'Galileo', 'R': 'GLONASS', 'J': 'QZSS', 'S': 'SBAS', 'I': 'NavIC'}
CRC_TABLE = []
for n in range(256):
    c = n << 16
    for _ in range(8):
        c = ((c << 1) ^ (0x1864CFB if c & 0x800000 else 0)) & 0xFFFFFF
    CRC_TABLE.append(c)


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def crc24(data):
    c = 0
    for v in data:
        c = ((c << 8) & 0xFFFFFF) ^ CRC_TABLE[(c >> 16) ^ v]
    return c


def bits(data, pos, n):
    if pos + n > len(data) * 8:
        raise ValueError('RTCM 消息头不完整')
    start, stop = pos // 8, (pos + n + 7) // 8
    return (int.from_bytes(data[start:stop], 'big') >> (stop * 8 - pos - n)) & ((1 << n) - 1)


def frames(mm, stats):
    i = 0
    while i + 6 <= len(mm):
        start = mm.find(b'\xd3', i)
        if start < 0:
            break
        if start + 3 > len(mm):
            stats['truncated_frames'] += 1
            break
        if mm[start + 1] & 0xFC:
            i = start + 1
            continue
        length = ((mm[start + 1] & 3) << 8) + mm[start + 2] + 6
        if start + length > len(mm):
            stats['truncated_frames'] += 1
            break
        frame = mm[start:start + length]
        if crc24(frame[:-3]) != int.from_bytes(frame[-3:], 'big'):
            stats['crc_errors'] += 1
            i = start + 1
            continue
        if length >= 8:
            yield bits(frame, 24, 12), frame
        i = start + length


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


def rtcm(path, repo, date=None, utc_offset=None):
    """CRC-checked MSM headers; signal tables come from the repository decoder."""
    source = repo / 'src/common/rtcm3.c'
    code = source.read_text(encoding='utf-8-sig')
    tables = {}
    for s, name in [('G', 'gps'), ('C', 'bds'), ('E', 'gal'), ('J', 'qzs')]:
        block = re.search(r'msm_sig_' + name + r'\[32\]\[2\]\s*=\s*\{(.*?)\};', code, re.S)
        if block:
            tables[s] = re.findall(r'"([^"]*)"', block[1])
    anchor = datetime.fromisoformat(date) if date else None
    anchor_source = 'user' if date else None
    if anchor is None:
        m = re.search(r'(?<!\d)(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)(?!\d)', path.stem)
        if m:
            anchor = datetime(*map(int, m.groups()))
            anchor_source = 'filename'
    stats = Counter()
    types = Counter()
    warnings = []
    antenna = ''
    with path.open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        # BDS/Galileo carry an untruncated week for the modern recording era.
        scratch = Counter()
        nav_anchor = None
        for index, (typ, b) in enumerate(frames(mm, scratch)):
            if typ == 1042:
                toe_bit = 36 + 6 + 13 + 4 + 14 + 5 + 17 + 11 + 22 + 24 + 5 + 18 + 16 + 32 + 18 + 32 + 18 + 32
                nav_anchor = GPS0 + timedelta(weeks=bits(b, 42, 13) + 1356, seconds=bits(b, toe_bit, 17) * 8 + 14)
            elif typ in (1045, 1046):
                toe_bit = 36 + 6 + 12 + 10 + 8 + 14 + 14 + 6 + 21 + 31 + 16 + 16 + 32 + 16 + 32 + 16 + 32
                nav_anchor = GPS0 + timedelta(weeks=bits(b, 42, 12) + 1024, seconds=bits(b, toe_bit, 14) * 60)
            if nav_anchor:
                if anchor and abs((anchor - nav_anchor).total_seconds()) > 7 * 86400:
                    if anchor_source == 'user':
                        raise ValueError('指定日期与导航完整周相差超过一周，请核实 --date')
                    warnings.append('文件名日期与导航完整周冲突，采用导航周定年')
                if anchor_source != 'user':
                    anchor, anchor_source = nav_anchor, f'RTCM-{typ}-week'
                break
            if anchor is not None and index >= 5000:
                break
        if anchor is None:
            raise ValueError('RTCM 缺少完整日期锚点；请用 --date YYYY-MM-DD 指定 GPST 日期')
        week0 = GPS0 + timedelta(weeks=int((anchor - GPS0).total_seconds() // 604800))
        first = last = None
        prev = {}
        intervals = []
        svs = set()
        observables = defaultdict(set)
        stations = set()
        for typ, b in frames(mm, stats):
            types[typ] += 1
            if typ in (1007, 1008, 1033) and len(b) > 7:
                length = bits(b, 48, 8)
                if 7 + length <= len(b) - 3:
                    antenna = b[7:7 + length].decode('ascii', errors='replace').strip()
            family, subtype = divmod(typ, 10)
            s = {107: 'G', 108: 'R', 109: 'E', 110: 'S', 111: 'J', 112: 'C', 113: 'I'}.get(family)
            if s is None or not 1 <= subtype <= 7 or len(b) * 8 - 24 < 193:
                continue
            stations.add(bits(b, 36, 12))
            raw = bits(b, 48, 30)
            if s == 'R':
                if utc_offset is None:
                    warnings.append('GLONASS 时间头未用于定年：未给 GPST−UTC 秒差')
                    continue
                tow = (raw >> 27) * 86400 + (raw & ((1 << 27) - 1)) / 1000 - 10800 + utc_offset
            else:
                tow = raw / 1000 + (14 if s == 'C' else 0)
            if not 0 <= tow < 604815:
                continue
            t = week0 + timedelta(seconds=tow)
            reference = prev.get(s, anchor)
            while (t - reference).total_seconds() < -302400:
                t += timedelta(days=7)
            while (t - reference).total_seconds() > 302400:
                t -= timedelta(days=7)
            satmask, sigmask = bits(b, 97, 64), bits(b, 161, 32)
            ids = [n for n in range(64) if satmask & (1 << (63 - n))]
            sigs = [n for n in range(32) if sigmask & (1 << (31 - n))]
            n_cells = len(ids) * len(sigs)
            if not n_cells or len(b) * 8 - 24 < 193 + n_cells:
                continue
            cellmask = bits(b, 193, n_cells)
            if not cellmask:
                continue
            if s in prev and 0 < (t - prev[s]).total_seconds() < 3600 and len(intervals) < 20000:
                intervals.append((t - prev[s]).total_seconds())
            prev[s] = t
            first = min(first, t) if first else t
            last = max(last, t) if last else t
            active_signals = set()
            for row, sat in enumerate(ids):
                for column, signal_id in enumerate(sigs):
                    if cellmask & (1 << (n_cells - row * len(sigs) - column - 1)):
                        svs.add(f'{s}{sat + 1:02d}')
                        active_signals.add(signal_id)
            for n in active_signals:
                sig = tables.get(s, [''] * 32)[n]
                if sig:
                    types_present = ['C'] if subtype == 1 else ['L'] if subtype == 2 else ['C', 'L']
                    observables[s].update(v + sig for v in types_present)
    if not first or not svs:
        raise ValueError('没有可用 MSM 观测历元；仅含导航/产品的 RTCM 不能当作 O 文件')
    if len(stations) > 1:
        raise ValueError(f'发现多个测站号 {sorted(stations)}；请拆分后准备单站配置')
    warnings.append('RTCM 仅读取 CRC、MSM 历元/掩码；信号掩码不保证每个载波单元有有效观测值')
    if anchor_source == 'filename':
        warnings.append('完整周由文件名定年，需与录制日期一致')
    return dict(format='RTCM3', start=first.isoformat(), end=last.isoformat(), time_system='GPST',
                station=str(next(iter(stations), '')), antenna=antenna, interval_s=statistics.median(intervals) if intervals else None,
                systems=sorted({s[0] for s in svs}), satellites=sorted(svs), observables={s: sorted(v) for s, v in observables.items()},
                date_anchor=anchor_source, message_types=dict(types), frame_stats=dict(stats), warnings=sorted(set(warnings)),
                header_map_source=str(source), header_map_sha256=sha(source))


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
            raise ValueError('压缩 RTCM 请先在独立目录解压')
        result = rtcm(path, Path(repo), date, utc_offset)
    result.update(path=str(path), size=before.st_size, sha256=sha(path), scanner_sha256=sha(Path(__file__)))
    if path.stat().st_mtime_ns != before.st_mtime_ns or path.stat().st_size != before.st_size:
        raise ValueError('识别过程中观测文件发生变化')
    return result
