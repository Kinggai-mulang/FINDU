"""Exercise the shipped mode-0 decoder against an external read-only RTCM sample."""
import argparse, hashlib, json, mmap, os, subprocess, sys, tempfile
from collections import Counter
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'resources/product-tools'))
from observations import frames, bits, crc24

parser=argparse.ArgumentParser()
parser.add_argument('--engine',type=Path,required=True)
parser.add_argument('--rtcm',type=Path,required=True)
parser.add_argument('--date',required=True)
args=parser.parse_args()
engine=args.engine.resolve()
with args.rtcm.open('rb') as source,mmap.mmap(source.fileno(),0,access=mmap.ACCESS_READ) as data:
    observations=[]
    for typ,frame in frames(data,Counter()):
        if typ//10 in (107,109,111,112) and typ%10 in (4,5,6,7):observations.append(bytes(frame))
        if len(observations)>=50:break
assert observations,'sample has no observation frames'
with tempfile.TemporaryDirectory(prefix='findu-decode-') as tmp:
    root=Path(tmp);raw=root/'wrong-extension.data';raw.write_bytes(b''.join(observations))
    def scan(path,date='',output=None):
        target=output or root/'metadata.json';target.unlink(missing_ok=True) if output is None else None
        opt=root/'read.opt';opt.write_text(f'GNSS_PMode=0;\nGNSS_RoveFile={path};\nGNSS_DecodeOutput={target};\nGNSS_DecodeDate={date};\n')
        p=subprocess.run([str(engine),str(opt)],cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        return p.returncode,json.loads(target.read_text()) if target.exists() and output is None else None
    code,meta=scan(raw);assert code==0 and meta['status']=='needs_date',meta
    code,meta=scan(raw,args.date);assert code==0 and meta['status']=='ok' and meta['satellites'] and meta['observables'],meta
    base=meta
    # A valid UBX private payload containing valid RTCM frames is not itself observations.
    payload=observations[0];header=bytes([2,21,len(payload)&255,len(payload)>>8]);a=b=0
    for byte in header+payload:a=(a+byte)&255;b=(b+a)&255
    ubx=b'\xb5\x62'+header+payload+bytes([a,b]);private=root/'pure.ubx';private.write_bytes(ubx)
    assert scan(private)[0]!=0
    mixed=root/'mixed.ubx';mixed.write_bytes(ubx+raw.read_bytes())
    code,meta=scan(mixed,args.date);assert code==0 and meta['epochs']==base['epochs'] and meta['format']=='MIXED'
    broken=root/'broken.rtcm3';frame=bytearray(observations[0]);frame[-1]^=1;broken.write_bytes(frame+raw.read_bytes())
    code,meta=scan(broken,args.date);assert code==0 and meta['epochs']==base['epochs'] and meta['frame_stats']['frames_without_output']>0
    switched=[]
    for i,frame in enumerate(observations):
        frame=bytearray(frame)
        if i>=len(observations)//2:
            frame[4]=(frame[4]&0xf0);frame[5]=1
            frame[-3:]=crc24(frame[:-3]).to_bytes(3,'big')
        switched.append(frame)
    stations=root/'two-stations.rtcm3';stations.write_bytes(b''.join(switched))
    assert scan(stations,args.date)[0]!=0,'multiple stations must not become a single-station OPT'
    before=hashlib.sha256(raw.read_bytes()).hexdigest()
    alias=root/'alias.data';os.link(raw,alias)
    assert scan(raw,args.date,alias)[0]!=0
    assert hashlib.sha256(raw.read_bytes()).hexdigest()==before,'mode 0 changed input through an output alias'
    assert not list(root.glob('*.log')),'mode 0 created positioning logs'
    print(json.dumps(dict(status='passed',cases=['missing-date','wrong-extension','raw-observations','private-payload','mixed-UBX','bad-CRC','multiple-stations','hardlink-readonly'],sample=base),ensure_ascii=False))
