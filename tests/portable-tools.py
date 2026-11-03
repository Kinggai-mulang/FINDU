"""Check the relocated package's observation tools using its own Python runtime."""
import argparse
import gzip
import hashlib
import json
import mmap
import http.server
import threading
import os
from pathlib import Path
import sys

p=argparse.ArgumentParser()
p.add_argument('--app',type=Path,required=True)
p.add_argument('--inputs',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
a.output.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(a.app/'product-tools'))
from observations import inspect, NeedsDate
source=a.inputs/'DATA/ALLOY1018/COMMON_ROVE.rtcm3'
chunks=[]
with source.open('rb') as stream,mmap.mmap(stream.fileno(),0,access=mmap.ACCESS_READ) as data:
    offset=0
    while len(chunks)<50:
        start=data.find(b'\xd3',offset)
        assert start>=0
        offset=start+((data[start+1]&3)<<8)+data[start+2]+6
        frame=data[start:offset]
        kind=(frame[3]<<4)|(frame[4]>>4)
        if kind//10 in (107,109,111,112) and kind%10 in (4,5,6,7):
            chunks.append(frame)
raw=a.output/('wrong-extension.data' if os.name=='nt' else '观测 wrong-extension.data')
raw.write_bytes(b''.join(chunks))
before=hashlib.sha256(raw.read_bytes()).hexdigest()
try:
    inspect(raw,a.app/'product-tools')
except NeedsDate:
    pass
else:
    raise AssertionError('undated stream must require a GPST date')
meta=inspect(raw,a.app/'product-tools',date='2026-10-18')
assert meta['date_anchor']=='user' and meta['satellites'] and meta['observables']
assert hashlib.sha256(raw.read_bytes()).hexdigest()==before
compressed=raw.with_suffix('.gz')
with gzip.open(compressed,'wb') as f:f.write(raw.read_bytes())
other=inspect(compressed,a.app/'product-tools',date='2026-10-18')
assert (other['start'],other['end'])==(meta['start'],meta['end'])
rinex=inspect(a.inputs/'DATA/BAUT/BAUT00DEU_R_20240190000_01D_30S_MO.24o',a.app/'product-tools')
assert rinex['format']=='RINEX' and rinex['interval_s']==30
# Exercise the actual platform curl, decompression and clock validation without an external server.
from transfer import Transfer
clock=a.inputs/'DATA/BAUT/WUM0MGXFIN_20240190000_01D_30S_CLK.CLK'
payload=gzip.compress(clock.read_bytes())
class ClockServer(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length',str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self,*args):
        pass
with http.server.ThreadingHTTPServer(('127.0.0.1',0),ClockServer) as server:
    threading.Thread(target=server.serve_forever,daemon=True).start()
    transfer=Transfer(a.output/'download-cache',[],a.app/'product-tools/ThirdParty/FAST',timeout=15,attempts=1)
    task=dict(id='local-clock',kind='clk',urls=[f'http://127.0.0.1:{server.server_address[1]}/clock.CLK.gz'])
    downloaded=transfer.get(task)
    assert downloaded['status']=='ok' and downloaded['origin']=='download',downloaded
    assert hashlib.sha256(Path(downloaded['path']).read_bytes()).digest()==hashlib.sha256(clock.read_bytes()).digest()
    decoded=a.output/'gzip-command.clk'
    archive=a.output/'clock.gz';archive.write_bytes(payload)
    transfer.unpack(archive,'clock.Z',decoded)
    assert decoded.read_bytes()==clock.read_bytes()
    server.shutdown()
(a.output/'check.json').write_text(json.dumps(dict(raw=meta,rinex=rinex,python=sys.executable,prefix=sys.prefix),indent=2,ensure_ascii=False),encoding='utf8')
print('Bundled Python: observation checks, local HTTP curl download, clock validation and gzip command passed')
