"""Production adapter regression with read-only GNSS inputs and a localhost caster."""
import argparse
import json
import mmap
import os
from pathlib import Path
import re
import socketserver
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('--inputs', type=Path, required=True)
parser.add_argument('--engine', type=Path, required=True)
parser.add_argument('--bins', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
args.output = args.output.resolve()
suffix = '.exe' if os.name == 'nt' else ''

def run(name, values, timeout=240):
    with (args.output / (name + '.txt')).open('w', encoding='utf8') as log:
        result = subprocess.run([str(args.bins / (name + suffix)), *map(str, values)],
                                stdout=log, stderr=subprocess.STDOUT, timeout=timeout,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, name + ' failed; see evidence'

# Exercise production option loading, queue, launch, result parsing and indexing.
opts = []
for name in ['T01_PPPAR_FIN-WUM_STA', 'T02_PPPAR_FIN-WUM_KIN', 'T10_RTK_BASE-KT1VRS_KIN']:
    original = args.inputs / 'POST' / (name + '.opt')
    text = original.read_text(encoding='utf-8-sig')
    def absolute(match):
        key, value = match[1], match[2].strip()
        return key + ' = ' + (original.parent / value.replace('\\', '/')).resolve().as_posix() + ';' if value else match[0]
    text = re.sub(r'^(GNSS_\w*File)\s*=\s*([^;]*);', absolute, text, flags=re.M)
    opt = args.output / (name + '.opt')
    opt.write_text(text, encoding='utf8')
    opts.append(opt)
run('engine-check', [args.engine, args.output / 'post', 3, *opts])

def bits(data, pos, n):
    end = (pos + n + 7) // 8
    return (int.from_bytes(data[pos // 8:end], 'big') >> (end * 8 - pos - n)) & ((1 << n) - 1)

def frames(path):
    with path.open('rb') as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        offset = 0
        while offset + 6 < len(data):
            start = data.find(b'\xd3', offset)
            if start < 0 or start + 3 > len(data):
                break
            offset = start + ((data[start + 1] & 3) << 8) + data[start + 2] + 6
            if offset > len(data):
                break
            yield bytes(data[start:offset])

source = args.inputs / 'DATA/ALLOY1018'
groups, pending, last, first = [], bytearray(), None, None
for frame in frames(source / 'COMMON_ROVE.rtcm3'):
    kind = bits(frame, 24, 12)
    if kind // 10 in (107, 109, 111, 112) and kind % 10 in range(1, 8):
        epoch = bits(frame, 48, 30) / 1000 + (14 if kind // 10 == 112 else 0)
        if last is not None and epoch != last:
            groups.append(bytes(pending)); pending.clear()
            if len(groups) >= 50:
                break
        last = epoch
        if first is None:
            first = epoch
    pending.extend(frame)
nav = bytearray()
for frame in frames(source / 'BIAS_EPH2IGS_20261018T0958-20261019T1232.rtcm3'):
    if bits(frame, 24, 12) in (1019, 1020, 1042, 1044, 1045, 1046):
        nav.extend(frame)
    if len(nav) > 50000:
        break
products = [bytearray() for _ in groups]
for filename in ['PROD_SSRC00WHU0_20261018T0958-20261019T1232.rtcm3', 'BIAS_PPP-RTK_20261018T0958-20261019T1232.rtcm3']:
    for frame in frames(source / filename):
        kind = bits(frame, 24, 12)
        if 1063 <= kind <= 1068 or kind == 1266:
            continue
        if 1057 <= kind <= 1062 or 1240 <= kind <= 1263 or 1265 <= kind <= 1270:
            epoch = bits(frame, 36, 20) + (14 if 1258 <= kind <= 1263 or kind == 1270 else 0)
        elif kind == 4076:
            epoch = bits(frame, 47, 20)
        else:
            continue
        index = max(0, int(epoch - first))
        if index >= len(products):
            break
        products[index].extend(frame)
assert len(groups) == 50 and nav and any(products)

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            self.request.settimeout(5)
            data = b''
            while b'\r\n\r\n' not in data:
                part = self.request.recv(4096)
                if not part:
                    return
                data += part
            self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: gnss/data\r\n\r\n')
            product = b'GET /products ' in data
            if not product:
                self.request.sendall(nav)
            start = time.monotonic() + 2 - (.4 if product else 0)
            for i, group in enumerate(products if product else groups):
                delay = start + i - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                self.request.sendall(group)
        except OSError:
            pass

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(('127.0.0.1', 0), Handler) as server:
    threading.Thread(target=server.serve_forever, daemon=True).start()
    requests = []
    for i in range(16):
        rtk = i < 8
        values = {'GNSS_PMode': '6' if rtk else '2', 'GNSS_ARMode': '0',
                  'GNSS_SatSYS': 'SYSGPS|SYSGAL|SYSBDS', 'GNSS_RoveSampleTime': '1',
                  'GNSS_BaseSampleTime': '1', 'GNSS_ATXFile': str(args.inputs / 'DATA/COMMON/antenna.atx'),
                  'GNSS_bUsePPPOSB': 'ON', 'GNSS_bRecordRTCM3': 'OFF', 'GNSS_bOutputULog': 'OFF',
                  'PRODUCT_NTRIP_Type': 'SSR'}
        for role, mount, kind in [('ROVE', 'obs', 'OBS|EPH'), ('BASE', 'obs', 'OBS|EPH')] if rtk else [('ROVE', 'obs', 'OBS|EPH'), ('PRODUCT', 'products', 'ORB|CLK|CODE_OSB|PHASE_OSB')]:
            values.update({f'{role}_NTRIP_CasterHost': '127.0.0.1', f'{role}_NTRIP_Port': str(server.server_address[1]),
                           f'{role}_NTRIP_Mountpoint': mount, f'{role}_NTRIP_DataType': kind})
        opt = args.output / ('live-' + str(i) + '.opt')
        opt.write_text('\n'.join(k + ' = ' + v + ';' for k, v in values.items()), encoding='utf8')
        requests.append(dict(sourcePath=str(opt), values={}, outputDir=str(args.output / 'live'), label='platform-' + str(i), station='ALLOY'))
    request = args.output / 'requests.json'
    request.write_text(json.dumps(requests), encoding='utf8')
    run('integration-check', [args.engine, args.output / 'live-backend', request, '--satellites'], 75)
    for req in requests[:2]:
        req['values'] = {'GNSS_PMode': '0'}
    request.write_text(json.dumps(requests[:2]), encoding='utf8')
    run('record-check', [args.engine, args.output / 'record-backend', request], 60)
    server.shutdown()
print(json.dumps({'status': 'passed', 'postCases': 3, 'liveSessions': 16, 'recordSessions': 2, 'restarts': 2, 'platform': os.name}))
