"""Satellite DSB validation from IPSPOS dcb_update; independent snapshot."""
from datetime import datetime,timedelta
from pathlib import Path
import re,math,hashlib
from bias_formats import GPS0,read
def sha(data): return hashlib.sha256(data).hexdigest()

def validate(path, as_of, hold_days, required_pairs):
    """Use the shared Bias-SINEX reader and qualify the subset accepted by the C bridge.

    Require both requested GPS relations within the SAME causal interval. A newer file
    containing only cross-frequency DSBs must not displace useful same-band products.
    """
    raw = Path(path).read_bytes()
    text = raw.decode('utf-8')
    if not text.startswith('%=BIA') or not text.rstrip().endswith('%=ENDBIA'):
        raise ValueError('Incomplete Bias-SINEX header/end marker')
    time_systems = {line[40:48].strip() for line in text.splitlines()
                    if 'TIME_SYSTEM' in line and not line.startswith('*')}
    if not time_systems or not time_systems <= {'G', 'GPS'}:
        raise ValueError('The solver DSB bridge requires explicit GPS time')
    # This daily-product updater qualifies intervals at the GPST date boundary.
    # The C consumer remains authoritative for exact second-level expiry/causality.
    evaluation = (datetime.combine(as_of, datetime.min.time()) - GPS0).total_seconds()
    groups, latest = {}, {}
    for row in read(path, 'bsx'):
        meta = row['meta']
        if meta['bias_type'] != 'DSB' or meta['station']:
            continue
        a, b = meta['obs'], meta['obs2']
        if len(a) != 3 or len(b) != 3 or not a.startswith('C') or not b.startswith('C'):
            continue
        if not re.fullmatch(r'C[1-9][A-Z]', a) or not re.fullmatch(r'C[1-9][A-Z]', b):
            raise ValueError('Malformed satellite DSB code signal')
        if a == b or row['units']['bias'] != 'm' or 'slope' in row['values']:
            raise ValueError('Unsupported satellite DSB identity, unit or slope')
        bias, std = row['values']['bias'], row['values']['std']
        if not all(math.isfinite(v) for v in [bias, std, std*std]) or std < 0:
            raise ValueError('Nonfinite satellite DSB or invalid formal sigma')
        if row['until'] <= row['t']:
            raise ValueError('Nonpositive DSB validity interval')
        satellite = row['entity'].split(':')[0]
        if not re.fullmatch(r'[GRECJ][0-9]{2}', satellite):
            continue
        first, second = sorted([a[1:], b[1:]])
        bias *= 1 if a[1:] == first else -1
        if row['t'] > evaluation:
            continue
        pair = (satellite, first, second)
        previous = latest.get(pair)
        if previous and row['t'] < previous[0]:
            continue
        if previous and row['t'] == previous[0]:
            if row['until'] != previous[1] or abs(bias-previous[2]) > 1e-9 or abs(std*std-previous[3]) > 1e-12:
                raise ValueError('Conflicting duplicate satellite DSB interval')
            continue
        latest[pair] = row['t'], row['until'], bias, std*std
    pair_counts = {}
    for (satellite, first, second), (start, end, bias, var) in latest.items():
        pair_counts[satellite] = pair_counts.get(satellite, 0) + 1
        if pair_counts[satellite] > 32:
            raise ValueError('More than 32 DSB pairs per satellite exceeds the native bridge capacity')
        if end + hold_days*86400 <= evaluation:
            continue
        group = groups.setdefault((start, end), {})
        graph = group.setdefault(satellite, {})
        graph.setdefault(first, set()).add(second)
        graph.setdefault(second, set()).add(first)
    eligible = []
    for (start, end), satellites in groups.items():
        coverage = {}
        for requirement in required_pairs:
            system, first, second = requirement['system'], *requirement['signals']
            found = 0
            for sv, graph in satellites.items():
                if not sv.startswith(system):
                    continue
                pending, seen = [first], {first}
                while pending:
                    node = pending.pop()
                    for adjacent in graph.get(node, set()) - seen:
                        seen.add(adjacent)
                        pending.append(adjacent)
                found += second in seen
            coverage[system+':'+first+'-'+second] = found
        if all(coverage[r['system']+':'+ '-'.join(r['signals'])] >= r.get('min_satellites', 1) for r in required_pairs):
            eligible.append((start, end, coverage, len(satellites)))
    if not eligible:
        raise ValueError('No causal, unexpired interval covers the required same-band relations')
    start, end, coverage, satellites = max(eligible)
    return {'sha256': sha(raw), 'bytes': len(raw), 'start_gpst_s': start, 'end_gpst_s': end,
            'start_gpst': (GPS0+timedelta(seconds=start)).isoformat(),
            'end_gpst': (GPS0+timedelta(seconds=end)).isoformat(),
            'hold_expiry_gpst': (GPS0+timedelta(seconds=end+hold_days*86400)).isoformat(),
            'required_pair_coverage': coverage, 'satellites_in_interval': satellites}

