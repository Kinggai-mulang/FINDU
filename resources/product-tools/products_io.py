"""Content checks and standard daily-product assembly for IPSPOS."""
import math
import hashlib
import re
import shutil
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

from observations import calendar, gpst_shift, sha


def bias_time(text):
    year, doy, second = map(int, text.split(':'))
    if year < 100:
        year += 2000 if year < 80 else 1900
    if doy < 1 or doy > 366:
        raise ValueError('OSB 使用开放时间区间，不能自动判定覆盖')
    return datetime(year, 1, 1) + timedelta(days=doy - 1, seconds=second)


def frame_name(value):
    return (value or '').upper().replace('IGB', 'IGS')


def finite(text):
    value = float(text.replace('D', 'E').replace('d', 'e'))
    if not math.isfinite(value):
        raise ValueError('产品含非有限数值')
    return value


def product_info(path, kind):
    path = Path(path)
    stats = defaultdict(lambda: dict(count=0, first=None, last=None, max_gap_s=0, gaps=[]))
    signals = defaultdict(set)
    intervals = defaultdict(list)
    time_system = 'GPS' if kind == 'nav' else None
    frame = None
    count = 0
    t = None
    header_end = False
    ended = False
    head = []
    antenna_models = set()
    antenna_validity = defaultdict(list)
    antenna_key = None
    valid_from, valid_until = datetime.min.isoformat(), datetime.max.isoformat()
    nav_remaining = 0
    first_line = None
    with path.open('rt', encoding='ascii', errors='strict') as f:
        for line in f:
            if first_line is None:
                first_line = line
            if len(head) < 600:
                head.append(line)
            if line.startswith(('<!DOCTYPE', '<html', '<HTML', '{"error')):
                raise ValueError('下载内容是错误网页或接口错误')
            label = line[60:].strip()
            sv = signal = None
            if kind == 'sp3':
                if line.startswith('#') and not line.startswith('##'):
                    frame = line[46:51].strip()
                if line.startswith('%c') and time_system is None:
                    time_system = line[9:12].strip()
                if line.startswith('*'):
                    t = calendar(line[1:].split()) + timedelta(seconds=gpst_shift(time_system or 'unknown', None))
                elif line.startswith('P'):
                    if t is None:
                        raise ValueError('SP3 位置记录前没有历元')
                    xyz = [finite(line[i:i + 14]) for i in (4, 18, 32)]
                    if all(v != 0 and abs(v) < 999999 for v in xyz):
                        sv = line[1:4].strip()
                elif line.startswith('EOF'):
                    ended = True
            elif kind == 'clk':
                if label == 'TIME SYSTEM ID':
                    time_system = line[:60].strip()
                elif label == 'END OF HEADER':
                    header_end = True
                elif line.startswith('AS '):
                    p = line.split()
                    if len(p) < 10 or len(p) < 9 + int(p[8]):
                        raise ValueError('CLK 卫星钟记录被截断')
                    finite(p[9])
                    t = calendar(p[2:8]) + timedelta(seconds=gpst_shift(time_system or 'unknown', None))
                    sv = p[1]
            elif kind == 'bia':
                if 'TIME_SYSTEM' in line:
                    time_system = line.split()[-1]
                if line.startswith(' OSB '):
                    # Receiver biases have a nonempty station field and are not satellite OSBs.
                    if line[15:24].strip():
                        continue
                    p = line.split()
                    if len(p) < 9:
                        raise ValueError('OSB 记录被截断')
                    sv = line[11:14].strip()
                    signal = line[25:29].strip()
                    times = re.findall(r'\d{4}:\d{3}:\d{5}', line)
                    if len(times) < 2 or not re.fullmatch(r'[GRECJSI]\d{2}', sv):
                        raise ValueError('不能识别卫星 OSB 的 PRN 或有效期')
                    start, end = map(bias_time, times[:2])
                    if end <= start:
                        raise ValueError('OSB 有效期为空或倒序')
                    # ns is the supported satellite Bias-SINEX unit in IPSPOS.
                    tail = line.split(times[1], 1)[1].split()
                    if len(tail) < 3 or tail[0] != 'ns':
                        raise ValueError('OSB 单位不是 IPSPOS 支持的 ns')
                    finite(tail[1])
                    intervals[sv + ':' + signal].append([start.isoformat(), end.isoformat()])
                    signals[sv[0]].add(signal)
                    t = start
                elif line.startswith('%=ENDBIA'):
                    ended = True
            elif kind == 'nav':
                if label == 'END OF HEADER':
                    header_end = True
                elif header_end and re.match(r'^[GRECJI]\d\d ', line):
                    if nav_remaining:
                        raise ValueError('广播星历多行记录被截断')
                    sv = line[:3]
                    nav_remaining = 3 if sv[0] == 'R' else 7
                    t = calendar(line[3:23].split())
                    if sv[0] == 'C':
                        t += timedelta(seconds=14)
                elif header_end and nav_remaining and line.startswith('    '):
                    nav_remaining -= 1
            elif kind == 'atx':
                if label == 'START OF ANTENNA':
                    antenna_key = None
                    valid_from, valid_until = datetime.min.isoformat(), datetime.max.isoformat()
                if label == 'TYPE / SERIAL NO':
                    model = ' '.join(line[:20].split())
                    antenna_models.add(model)
                    serial = line[20:40].strip()
                    antenna_key = serial if re.fullmatch(r'[GRECJ]\d{2}', serial) else model
                elif label == 'VALID FROM':
                    valid_from = calendar(line[:60].split()).isoformat()
                elif label == 'VALID UNTIL':
                    valid_until = calendar(line[:60].split()).isoformat()
                if label == 'END OF ANTENNA':
                    count += 1
                    ended = True
                    if antenna_key:
                        antenna_validity[antenna_key].append([valid_from, valid_until])
            if sv is not None:
                if not re.fullmatch(r'[GRECJSI]\d{2}', sv):
                    raise ValueError('无效产品卫星号')
                row = stats[sv]
                if row['last'] is not None:
                    gap = (t - datetime.fromisoformat(row['last'])).total_seconds()
                    if gap < 0 and kind not in ('bia', 'nav'):
                        raise ValueError('产品中同星历元倒序')
                    row['max_gap_s'] = max(row['max_gap_s'], gap)
                    if kind in ('sp3', 'clk') and gap > (1800 if kind == 'sp3' else 300):
                        row['gaps'].append([row['last'], t.isoformat()])
                row['first'] = min(row['first'], t.isoformat()) if row['first'] else t.isoformat()
                row['last'] = max(row['last'], t.isoformat()) if row['last'] else t.isoformat()
                row['count'] += 1
                count += 1
    if kind == 'nav' and nav_remaining:
        raise ValueError('广播星历在记录中途结束')
    if kind == 'atx':
        text = ''.join(head)
        if 'ANTEX VERSION / SYST' not in text or not count or not ended:
            raise ValueError('ANTEX 文件不完整')
        frame = 'IGS20' if re.search(r'(?:aligned to|to|week \d+) IGS20', text, re.I) else ('IGS14' if 'IGS14' in text or 'igs14.atx' in path.name.lower() else None)
    elif not count:
        raise ValueError('产品没有有效记录')
    if kind == 'sp3' and (not first_line.startswith(('#a', '#b', '#c', '#d')) or not ended):
        raise ValueError('SP3 头或 EOF 缺失')
    if kind in ('clk', 'nav') and (not header_end or 'RINEX VERSION / TYPE' not in ''.join(head[:1])):
        raise ValueError('RINEX 产品头不完整')
    if kind == 'bia' and (not first_line.startswith('%=BIA') or not ended):
        raise ValueError('Bias-SINEX 头或结束标记缺失')
    return dict(kind=kind, records=count, time_system=time_system, frame=frame, satellites=dict(stats),
                signals={s: sorted(v) for s, v in signals.items()}, intervals=dict(intervals),
                antenna_models=sorted(antenna_models), antenna_validity=dict(antenna_validity), validator_sha256=sha(Path(__file__)), sha256=sha(path), size=path.stat().st_size)


def covers(intervals, start, end):
    cursor = start
    for a, b in sorted(intervals):
        a, b = datetime.fromisoformat(a), datetime.fromisoformat(b)
        if b <= cursor:
            continue
        if a > cursor:
            return False
        cursor = max(cursor, b)
        if cursor > end:  # Bias validity end is exclusive.
            return True
    return False


def check_bundle(meta, observation, systems, mode, receiver_antenna, bias_time_system=None):
    """Check actual requested-window support; report partial satellites separately."""
    start, end = map(datetime.fromisoformat, [observation['start'], observation['end']])
    errors, warnings = [], []
    for kind in ('sp3', 'clk', 'nav'):
        if kind not in meta:
            errors.append(f'缺少 {kind} 产品')
    if mode == 'ar' and 'bia' not in meta:
        errors.append('缺少相位 OSB')
    if 'atx' not in meta:
        errors.append('缺少适用天线文件')
    if errors:
        return dict(ready=False, errors=errors, warnings=warnings)
    if mode == 'ar' and meta['bia']['time_system'] not in ('G', 'GPS'):
        if meta['bia']['time_system'] is None and bias_time_system == 'GPS':
            warnings.append('OSB 缺少 TIME_SYSTEM；本次由显式 --bias-time-system GPS 指定，原文件未修改')
        else:
            errors.append('OSB 缺少或不支持 TIME_SYSTEM；核实时标后才能显式使用 --bias-time-system GPS')
    orbit_frame, antenna_frame = meta['sp3']['frame'], meta['atx']['frame']
    if not orbit_frame or not antenna_frame or frame_name(orbit_frame) != frame_name(antenna_frame):
        errors.append(f'轨道与天线参考框架未匹配：{orbit_frame} / {antenna_frame}')
    model = ' '.join((receiver_antenna or '').split())
    receiver_ready = model in meta['atx']['antenna_models'] and covers(
        meta['atx']['antenna_validity'].get(model, []), start, end)
    if not receiver_ready:
        reason = '无匹配记录' if model not in meta['atx']['antenna_models'] else '标定有效期未覆盖观测'
        warnings.append(f'接收机天线标定未应用：{model or "观测未声明型号"}（{reason}）；保留有效卫星天线标定，不因此关闭 AR。')
    common = set(meta['sp3']['satellites']) & set(meta['clk']['satellites'])
    observed = set(observation['satellites'])
    usable, missing_satellite_antenna = [], []
    for sv in sorted(common & observed):
        if sv[0] not in systems:
            continue
        valid = True
        for kind, gap_limit in [('sp3', 1800), ('clk', 300)]:
            row = meta[kind]['satellites'][sv]
            # Only full-session satellites enter this conservative readiness subset.
            valid &= row['first'] <= start.isoformat() and row['last'] >= end.isoformat()
            valid &= not any(a < end.isoformat() and b > start.isoformat() for a, b in row.get('gaps', []))
        satellite_ready = covers(meta['atx']['antenna_validity'].get(sv, []), start, end)
        if not satellite_ready:
            missing_satellite_antenna.append(sv)
        valid &= satellite_ready
        if valid:
            usable.append(sv)
    ar_svs, coverage = [], {}
    for s in systems:
        phase = [v for v in observation['observables'].get(s, []) if v.startswith('L') and len(v) == 3]
        candidates = [sv for sv in usable if sv.startswith(s)]
        matches = {}
        if mode == 'ar':
            for sv in candidates:
                matched = []
                for signal in phase:
                    code = 'C' + signal[1:]
                    valid_phase = covers(meta['bia']['intervals'].get(sv + ':' + signal, []), start, end)
                    valid_code = covers(meta['bia']['intervals'].get(sv + ':' + code, []), start, end)
                    if valid_phase and valid_code:
                        matched.append(signal)
                if len({v[1] for v in matched}) >= 2:
                    matches[sv] = matched
                    ar_svs.append(sv)
        coverage[s] = dict(precise_satellites=candidates, dual_frequency_osb=matches)
        if not candidates:
            errors.append(f'{s} 没有同时覆盖观测时段的轨道/钟差卫星')
        elif mode == 'ar' and not matches:
            errors.append(f'{s} 没有与观测属性相匹配的双频码/相位 OSB 完整覆盖')
    if len(usable) < 5:
        errors.append('完整时段精密产品覆盖少于 5 颗观测卫星')
    if mode == 'ar' and len(ar_svs) < 5:
        errors.append('完整时段双频 OSB 匹配少于 5 颗卫星')
    missing = sorted(sv for sv in observed if sv[0] in systems and sv not in usable)
    if missing:
        warnings.append(f'{len(missing)} 颗观测卫星没有全时段精密覆盖；详见 coverage，不代表这些卫星完全不能使用')
    if missing_satellite_antenna:
        warnings.append('卫星天线标定缺失或有效期未覆盖观测：' + ', '.join(missing_satellite_antenna) + '；这些卫星不计入完整配套集合。')
    # Navigation must contain requested-system records near the observation window.
    for s in systems:
        rows = [r for sv, r in meta['nav']['satellites'].items() if sv.startswith(s)]
        if not any(datetime.fromisoformat(r['first']) <= end + timedelta(hours=4) and datetime.fromisoformat(r['last']) >= start - timedelta(hours=4) for r in rows):
            errors.append(f'广播星历缺少 {s} 在观测附近的记录')
    warnings.append('输入检查不验证 AR 固定率或定位正确性；需实际解算评估')
    return dict(ready=not errors, errors=errors, warnings=warnings, coverage=coverage,
                full_session_precise=usable, full_session_dual_osb=ar_svs,
                antenna=dict(receiver_model=model, receiver_calibrated=bool(receiver_ready),
                             satellite_missing=missing_satellite_antenna, frame=antenna_frame))


def assemble(paths, output, kind):
    paths = list(dict.fromkeys(map(Path, paths)))
    output = Path(output)
    if len(paths) == 1:
        shutil.copy2(paths[0], output)
        return
    if kind == 'atx':
        raise ValueError('不能拼接不同天线文件')
    if kind == 'sp3':
        epochs = {}
        owners = {}
        resolved = 0
        header = []
        def retain(epoch, lines, nominal):
            nonlocal resolved
            day = calendar(epoch[1:].split()).date()
            rank = 2 if day == nominal else 1
            if epoch in epochs and epochs[epoch] != lines:
                if rank == owners[epoch]:
                    raise ValueError('SP3 同日同等级重叠历元内容冲突')
                resolved += 1
            if rank >= owners.get(epoch, 0):
                epochs[epoch], owners[epoch] = lines, rank

        for n, p in enumerate(paths):
            current, block = None, []
            nominal = None
            m = re.search(r'_(\d{4})(\d{3})\d{4}_', p.name)
            if m:
                nominal = (datetime(int(m[1]), 1, 1) + timedelta(days=int(m[2]) - 1)).date()
            for line in p.read_text(encoding='ascii').splitlines(True):
                if line.startswith('*'):
                    if nominal is None:
                        nominal = calendar(line[1:].split()).date()
                    if current:
                        retain(current, block, nominal)
                    current, block = line, [line]
                elif current and not line.startswith('EOF'):
                    block.append(line)
                elif current is None and n == 0:
                    header.append(line)
            if current:
                retain(current, block, nominal)
        first = min(epochs)
        dt = calendar(first[1:].split())
        stamp = f'{dt.year:4d} {dt.month:2d} {dt.day:2d} {dt.hour:2d} {dt.minute:2d} {dt.second + dt.microsecond / 1e6:11.8f}'
        header[0] = header[0][:3] + stamp + ' ' + f'{len(epochs):7d}' + header[0][39:]
        satellites = sorted({line[1:4] for block in epochs.values() for line in block if line.startswith('P')})
        list_start = next((i for i, line in enumerate(header) if line.startswith('+ ')), None)
        if list_start is not None:
            rest_start = next((i for i in range(list_start, len(header)) if not header[i].startswith('+')), len(header))
            rows = max(5, (len(satellites) + 16) // 17)
            lists, accuracy = [], []
            for i in range(rows):
                names = satellites[i * 17:(i + 1) * 17]
                prefix = f'+  {len(satellites):3d}   ' if i == 0 else '+        '
                lists.append(prefix + ''.join(names) + '  0' * (17 - len(names)) + '\n')
                accuracy.append('++       ' + '  0' * 17 + '\n')
            header = header[:list_start] + lists + accuracy + header[rest_start:]
        output.write_text(''.join(header) + ''.join(''.join(epochs[k]) for k in sorted(epochs)) + 'EOF\n', encoding='ascii')
        return dict(overlap_epochs_resolved=resolved, overlap_policy='历元所属日产品优先；同日冲突拒绝')
    elif kind in ('clk', 'nav'):
        # Inputs are chronological daily files; stream large clocks without loading them into RAM.
        with output.open('w', encoding='ascii', newline='\n') as out:
            seen = set()
            for n, p in enumerate(paths):
                in_body = False
                day_match = re.search(r'_(\d{4})(\d{3})\d{4}_', p.name)
                nominal = (datetime(int(day_match[1]), 1, 1) + timedelta(days=int(day_match[2]) - 1)).date() if day_match else None
                with p.open(encoding='ascii') as f:
                    for line in f:
                        if not in_body:
                            if n == 0:
                                out.write(line)
                            if 'END OF HEADER' in line:
                                in_body = True
                            continue
                        if kind == 'clk':
                            tokens = line.split()
                            if len(tokens) >= 9 and tokens[0] in ('AS', 'AR'):
                                if nominal and calendar(tokens[2:8]).date() != nominal:
                                    continue
                                key = hashlib.blake2b(' '.join(tokens[:8]).encode('ascii'), digest_size=16).digest()
                                # Compact keys avoid keeping clock lines/token strings in memory.
                                if key in seen:
                                    continue
                                seen.add(key)
                        out.write(line)
    elif kind == 'bia':
        header, records = [], {}
        for n, p in enumerate(paths):
            body = False
            for line in p.read_text(encoding='ascii').splitlines(True):
                if line.startswith('+BIAS/SOLUTION'):
                    body = True
                    continue
                if line.startswith('-BIAS/SOLUTION'):
                    body = False
                    break
                if not body and n == 0:
                    header.append(line)
                elif body and line.startswith((' OSB ', ' DSB ')):
                    dates = re.findall(r'\d{4}:\d{3}:\d{5}', line)
                    key = (line[:35], tuple(dates[:2]))
                    if key in records and records[key] != line:
                        raise ValueError('OSB 重叠有效期内容冲突')
                    records[key] = line
        if header and records:
            tokens = header[0].split()
            all_dates = [d for line in records.values() for d in re.findall(r'\d{4}:\d{3}:\d{5}', line)[:2]]
            if len(tokens) >= 9 and all_dates:
                tokens[5], tokens[6], tokens[-1] = min(all_dates), max(all_dates), f'{len(records):08d}'
                header[0] = ' '.join(tokens) + '\n'
        output.write_text(''.join(header) + '+BIAS/SOLUTION\n' + ''.join(records[k] for k in sorted(records)) + '-BIAS/SOLUTION\n%=ENDBIA\n', encoding='ascii')
    else:
        raise ValueError('未知产品类型')
