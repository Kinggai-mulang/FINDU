"""Standard text products -> schema 1. RTCM bit decoding belongs to native_export.c."""
import gzip
import json
import math
import re
from datetime import datetime, timedelta

GPS0 = datetime(1980, 1, 6)
C = 299792458.0
KINDS = {'orbit', 'clock', 'code_osb', 'phase_osb', 'ionosphere', 'troposphere', 'dsb'}


def number(text):
    return float(text.replace('D', 'E').replace('d', 'e'))


def epoch(parts, system='GPS', utc_offset=None):
    """Reject unspecified/UTC/GLO scales; no assumed leap seconds in future data."""
    system = system.strip().upper()
    shift = {'GPS': 0, 'G': 0, 'GAL': 0, 'E': 0, 'BDT': 14, 'C': 14, 'TAI': -19}.get(system)
    if system in ('UTC', 'U') and utc_offset is not None and math.isfinite(utc_offset):
        shift = utc_offset
    if shift is None:
        raise ValueError(f'Time system {system!r} requires an explicit verified time adapter')
    y, m, d, h, minute = map(int, parts[:5])
    return (datetime(y, m, d, h, minute) + timedelta(seconds=number(str(parts[5]))) - GPS0).total_seconds() + shift


def ydoy(text, system, utc_offset=None):
    year, day, second = map(int, text.split(':'))
    if year < 100:
        year += 2000 if year < 80 else 1900
    if day < 1 or day > 366:
        raise ValueError(f'Open/invalid epoch {text}: supply finite validity bounds via schema 1')
    dt = datetime(year, 1, 1) + timedelta(days=day - 1, seconds=second)
    return epoch([dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second], system, utc_offset)


def sample(kind, entity, t, values, units, **extra):
    return dict(record='product', kind=kind, entity=entity, t=t, values=values, units=units, **extra)


def read(path, fmt, time_system=None, utc_offset=None):
    opener = gzip.open if str(path).lower().endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8-sig', errors='strict') as fp:
        if fmt == 'jsonl':
            for line in fp:
                if line.strip():
                    yield json.loads(line)
            return
        system = time_system
        block = None
        t = None
        exponent = None
        names, scales = [], []
        map_type = None
        for lineno, line in enumerate(fp, 1):
            label = line[60:].strip() if len(line) >= 60 else ''
            if fmt == 'sp3':
                if line.startswith('%c') and system is None:
                    # Standard SP3 %c time-system field (columns 10..12).
                    system = line[9:12].strip()
                if line.startswith('*'):
                    t = epoch(line[1:].split(), system or 'unknown', utc_offset)
                elif line.startswith('P') and t is not None:
                    sv = line[1:4].strip()
                    xyz = [number(line[a:a+14]) for a in (4, 18, 32)]
                    clock = number(line[46:60])
                    values = {k: None if v == 0 or abs(v) >= 999999 else v*1000 for k, v in zip(('x', 'y', 'z'), xyz)}
                    yield sample('orbit', sv, t, values, dict.fromkeys(values, 'm'), meta={'representation': 'ECEF', 'frame': 'SP3-header'})
                    yield sample('clock', sv, t, {'c0': None if abs(clock) >= 999999 else clock*1e-6*C}, {'c0': 'm'}, meta={'representation': 'absolute'})
            elif fmt == 'clk':
                if label == 'TIME SYSTEM ID' and system is None:
                    system = line[:3].strip()
                if line.startswith('AS '):
                    tokens = line.split()
                    t = epoch(tokens[2:8], system or 'unknown', utc_offset)
                    n = int(tokens[8])
                    if n < 1 or len(tokens) < 9+n:
                        raise ValueError(f'CLK line {lineno}: incomplete clock fields')
                    values = {'c0': number(tokens[9])*C}
                    if n >= 2:
                        values['std'] = number(tokens[10])*C
                    yield sample('clock', tokens[1], t, values, dict.fromkeys(values, 'm'), meta={'representation': 'absolute'})
            elif fmt == 'bsx':
                if 'TIME_SYSTEM' in line and not line.startswith('*') and system is None:
                    system = line.split()[-1]
                if line.startswith('+'):
                    block = line.strip()
                elif line.startswith('-'):
                    block = None
                elif block == '+BIAS/SOLUTION' and not line.startswith('*') and line.strip():
                    bt, svn, prn = line[1:5].strip(), line[6:10].strip(), line[11:14].strip()
                    station, obs, obs2 = line[15:24].strip(), line[25:29].strip(), line[30:34].strip()
                    start, end = ydoy(line[35:49], system or 'unknown', utc_offset), ydoy(line[50:64], system or 'unknown', utc_offset)
                    unit = line[65:69].strip()
                    factor = C*1e-9 if unit == 'ns' else 1 if unit in ('cyc', 'm') else None
                    if factor is None or bt not in ('OSB', 'DSB', 'ISB') or not obs:
                        raise ValueError(f'Bias-SINEX line {lineno}: unsupported bias/unit')
                    values = {'bias': number(line[70:91])*factor, 'std': number(line[92:103])*factor}
                    units = dict.fromkeys(values, 'm' if unit == 'ns' else unit)
                    if line[104:125].strip():
                        values['slope'] = number(line[104:125])*factor
                        units['slope'] = units['bias']+'/s'
                    kind = 'dsb' if bt != 'OSB' else 'phase_osb' if obs.startswith('L') else 'code_osb'
                    entity = (station+':'+prn if station else prn or svn)+':'+obs[1:]+(':'+obs2 if obs2 else '')
                    yield sample(kind, entity, start, values, units, until=end,
                                 meta={'bias_type': bt, 'svn': svn, 'station': station, 'obs': obs, 'obs2': obs2, 'integer': None})
            elif fmt == 'ionex':
                if label == 'EXPONENT':
                    exponent = int(line[:6])
                elif label in ('START OF TEC MAP', 'START OF RMS MAP', 'START OF HEIGHT MAP'):
                    map_type = label.split()[2]
                elif label == 'EPOCH OF CURRENT MAP':
                    # IONEX epochs are UTC. Explicit verified conversion is required here.
                    t = epoch(line[:60].split(), system or 'UTC', utc_offset)
                elif label == 'LAT/LON1/LON2/DLON/H' and map_type in ('TEC', 'RMS'):
                    if exponent is None or t is None:
                        raise ValueError('IONEX missing exponent/epoch')
                    lat, lo, hi, step, height = map(number, line[:60].split())
                    n = 1 if step == 0 and lo == hi else round((hi-lo)/step)+1 if step else 0
                    if n <= 0 or n > 10000:
                        raise ValueError('IONEX invalid longitude grid')
                    vals = []
                    while len(vals) < n:
                        row = next(fp)
                        if row[60:].strip() and re.search('[A-Za-z]', row[60:]):
                            raise ValueError('IONEX grid ended before values completed')
                        vals.extend(int(row[j:j+5]) for j in range(0, len(row.rstrip('\r\n')), 5) if row[j:j+5].strip())
                    if len(vals) != n:
                        raise ValueError('IONEX grid value count mismatch')
                    for j, value in enumerate(vals):
                        entity = f'{map_type}:lat{lat:g}:lon{lo+j*step:g}:h{height:g}'
                        yield sample('ionosphere', entity, t, {map_type.lower(): None if value == 9999 else value*10**exponent},
                                     {map_type.lower(): 'TECU'}, meta={'representation': map_type, 'latitude': lat, 'longitude': lo+j*step, 'height_km': height})
            elif fmt == 'tro':
                if 'TIME SYSTEM' in line and not line.startswith('*') and system is None:
                    system = line.split()[-1]
                if 'TROPO PARAMETER NAMES' in line:
                    names = line.split('TROPO PARAMETER NAMES', 1)[1].split()
                elif 'TROPO PARAMETER UNITS' in line:
                    scales = [number(x) for x in line.split('TROPO PARAMETER UNITS', 1)[1].split()]
                elif line.startswith('+'):
                    block = line.strip()
                elif line.startswith('-'):
                    block = None
                elif block == '+TROP/SOLUTION' and not line.startswith('*') and line.strip():
                    tokens = line.split()
                    if not names or len(names) != len(scales) or len(tokens) != len(names)+2 or any(s <= 0 for s in scales):
                        raise ValueError('SINEX-TRO parameter names/scales/count required')
                    if len(names) != len(set(names)):
                        # Repeated STDDEV fields are associated with their preceding parameter.
                        names = [name+'_'+str(i) if names.count(name)>1 else name for i,name in enumerate(names)]
                    values = {name: number(x)/scale for name, scale, x in zip(names, scales, tokens[2:])}
                    delay_names = {'TROTOT', 'TROWET', 'TRODRY', 'TGNTOT', 'TGETOT', 'TGNWET', 'TGEWET'}
                    units = {name: 'm' if name in delay_names else 'SI_from_header' for name in names}
                    # STDDEV carries the preceding parameter's unit; retain its association.
                    for i, name in enumerate(names):
                        if name.startswith('STD') and i:
                            units[name] = units[names[i-1]]
                    yield sample('troposphere', tokens[0], ydoy(tokens[1], system or 'unknown', utc_offset), values, units, meta={'parameter_names': names})
            else:
                raise ValueError(f'Unsupported format {fmt}')


def validate(record):
    if record.get('record') != 'product':
        return
    if record.get('kind') not in KINDS or not isinstance(record.get('entity'), str) or not record['entity']:
        raise ValueError('Product needs a supported kind and nonempty entity')
    if not isinstance(record.get('t'), (int, float)) or not math.isfinite(record['t']) or record['t'] < 0:
        raise ValueError('Product t must be continuous GPST seconds')
    if record.get('until') is not None and record['until'] <= record['t']:
        raise ValueError('Validity interval must be [t, until) with until > t')
    if not isinstance(record.get('values'), dict) or not record['values']:
        raise ValueError('Product needs numeric values; absent fields must not be invented')
    units = record.get('units', {})
    for key, value in record['values'].items():
        if value is not None and (not isinstance(value, (float, int)) or not math.isfinite(value)):
            raise ValueError(f'Nonfinite/non-numeric value {key}; use null for missing')
        if not record.get('unit') and not units.get(key):
            raise ValueError(f'Unit required for {key}')
    if record.get('udi') is not None and (not math.isfinite(record['udi']) or record['udi'] < 0):
        raise ValueError('UDI must be finite and nonnegative')
