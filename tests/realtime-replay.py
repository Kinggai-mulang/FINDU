"""Compare 16 native RTK/PPP clients with frame/epoch barriers, never catch-up bursts.

ALLOY1018 is replayed as a zero-baseline RTK and SSR PPP protocol fixture.
Navigation goes only to observation streams. Every accepted product/base batch
is confirmed before rover input; each full Log=4 row is compared before advancing.
Windows only. Raw inputs remain read-only; evidence is written to a new directory.
"""
from pathlib import Path
import argparse, ctypes, hashlib, json, mmap, os, socket, socketserver, subprocess, threading, time
P=argparse.ArgumentParser(description=__doc__)
P.add_argument('--source',type=Path,required=True,help='ALLOY1018 read-only fixture directory')
P.add_argument('--baseline',type=Path,required=True,help='unmodified BetaV0.611 IPSClient.exe')
P.add_argument('--candidate',type=Path,required=True,help='candidate IPSClient.exe')
P.add_argument('--output',type=Path,required=True,help='new evidence directory')
P.add_argument('--seconds',type=int,default=120)
A=P.parse_args();assert 0<A.seconds<=1805
BASE=Path(__file__).resolve().parents[1];ROOT=A.output.resolve();ROOT.mkdir(parents=True,exist_ok=False)
SOURCE=A.source.resolve();A.baseline=A.baseline.resolve();A.candidate=A.candidate.resolve()
def frames(path):
 with path.open('rb') as stream, mmap.mmap(stream.fileno(),0,access=mmap.ACCESS_READ) as data:
  offset=0
  while offset+6<len(data):
   start=data.find(b'\xd3',offset)
   if start<0:break
   size=((data[start+1]&3)<<8)+data[start+2]+6
   offset=start+size
   if offset>len(data):break
   yield bytes(data[start:offset])
def bits(data,pos,n):
 a,b=pos//8,(pos+n+7)//8
 return (int.from_bytes(data[a:b],'big')>>(b*8-pos-n))&((1<<n)-1)
groups=[];pending=bytearray();last=None;first_epoch=None
for frame in frames(SOURCE/'COMMON_ROVE.rtcm3'):
 typ=bits(frame,24,12)
 if typ//10 in (107,109,111,112) and typ%10 in range(1,8):
  epoch=bits(frame,48,30)/1000+(14 if typ//10==112 else 0)
  if last is not None and epoch!=last:
   groups.append(bytes(pending));pending.clear()
   if len(groups)>=1900:break
  last=epoch
  if first_epoch is None:first_epoch=epoch
 pending.extend(frame)
nav=bytearray()
for frame in frames(SOURCE/'BIAS_EPH2IGS_20261018T0958-20261019T1232.rtcm3'):
 if bits(frame,24,12) in (1019,1020,1042,1044,1045,1046):nav.extend(frame)
 if len(nav)>50000:break
products=[bytearray() for _ in groups]
for filename in ['PROD_SSRC00WHU0_20261018T0958-20261019T1232.rtcm3','BIAS_PPP-RTK_20261018T0958-20261019T1232.rtcm3']:
 for frame in frames(SOURCE/filename):
  typ=bits(frame,24,12)
  if 1063<=typ<=1068 or typ==1266:continue
  if 1057<=typ<=1062 or 1240<=typ<=1263 or 1265<=typ<=1270:
   epoch=bits(frame,36,20)+(14 if 1258<=typ<=1263 or typ==1270 else 0)
  elif typ==4076:epoch=bits(frame,47,20)
  else:continue
  index=max(0,int(epoch-first_epoch))
  if index>=len(products):break
  products[index].extend(frame)
nav=bytes(nav)
def frame_count(data):
 n=p=0
 while p<len(data):
  assert data[p]==211;n+=1;p+=((data[p+1]&3)<<8)+data[p+2]+6
 assert p==len(data);return n
connections={};done=threading.Event()
class Handler(socketserver.BaseRequestHandler):
 def handle(self):
  self.request.settimeout(10);data=b''
  while b'\r\n\r\n' not in data:data+=self.request.recv(4096)
  index,role=data.split(b' ')[1].decode().strip('/').split('/')
  self.request.setsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY,1)
  self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: gnss/data\r\n\r\n');key=(int(index),role)
  assert key not in connections,'unexpected reconnect';connections[key]=self.request;done.wait()
class Server(socketserver.ThreadingTCPServer):allow_reuse_address=True;daemon_threads=True
server=Server(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();port=server.server_address[1]
class Memory(ctypes.Structure):
 _fields_=[('cb',ctypes.c_ulong),('faults',ctypes.c_ulong),*[(n,ctypes.c_size_t) for n in ('peak','working','poolPeak','pool','nonpoolPeak','nonpool','pagefile','peakPagefile','private')]]
k=ctypes.WinDLL('kernel32',use_last_error=True);k.OpenProcess.restype=ctypes.c_void_p;k.CloseHandle.argtypes=[ctypes.c_void_p]
ps=ctypes.WinDLL('psapi');ps.GetProcessMemoryInfo.argtypes=[ctypes.c_void_p,ctypes.POINTER(Memory),ctypes.c_ulong]
def memory(pid):
 h=k.OpenProcess(0x410,False,pid);m=Memory();m.cb=ctypes.sizeof(m)
 if h:ps.GetProcessMemoryInfo(h,ctypes.byref(m),m.cb);k.CloseHandle(h)
 return m.private
resources=[];fault=False;released=None;sessions=[];samples=[];counts={};stop=threading.Event();selected=[2];started=time.monotonic()
def heartbeat():
 last={}
 while not stop.wait(.4):
  for i in (2,10):
   folder=sessions[i]['folder'];lease=folder/'satellites.request'
   if selected[0]==i:lease.write_text(str(int(time.time())+5))
   else:lease.unlink(missing_ok=True)
   try:
    obj=json.loads((folder/'satellites.json').read_text())
    if last.get(i)!=obj['sequence']:
     last[i]=obj['sequence'];samples.append(dict(session=i,at=time.monotonic()-started,sequence=obj['sequence'],captureMs=obj['captureMs'],bytes=(folder/'satellites.json').stat().st_size,tow=obj['tow']))
     (ROOT/f'latest-{i}.json').write_text(json.dumps(obj,indent=2))
   except (OSError,ValueError):pass

def wait_for(test,label,timeout=15):
 end=time.monotonic()+timeout
 while not test():
  assert all(s['p'].poll() is None for s in sessions),'client exited'
  if time.monotonic()>end:raise TimeoutError(label)
  time.sleep(.015)

def status(s):
 if not s.get('status'):s['status']=next(s['folder'].rglob('NTRIP_*.log'),None)
 if not s['status']:return {}
 with s['status'].open('rb') as f:
  f.seek(max(0,s['status'].stat().st_size-8192));lines=f.read().decode(errors='replace').splitlines()
 result={}
 for line in lines:
  v=line.split()
  if len(v)==13 and v[1] in ('ROVE','BASE','PRODUCT'):
   result[v[1]]=int(v[7]);assert int(v[12])==0,f'queue overflow {s["index"]}: {line}'
 return result

def accepted():
 states=[status(s) for s in sessions]
 return all(states[i].get(role,0)>=n for (i,role),n in counts.items())

def send(i,role,data):
 if data:connections[i,role].sendall(data);counts[i,role]=counts.get((i,role),0)+frame_count(data)

def rows(s):
 if not s.get('log'):
  for f in s['folder'].rglob('*.log'):
   with f.open('rb') as h:header=h.read(18000)
   if b'Log=4' in header:s['log']=f;break
 if not s.get('log'):return s['rows']
 with s['log'].open('rb') as f:f.seek(s['offset']);data=s['pending']+f.read();s['offset']=f.tell()
 lines=data.split(b'\n');s['pending']=lines.pop()
 s['rows'].extend(l.strip().decode() for l in lines if l.strip() and not l.startswith(b'#'))
 return s['rows']

try:
 for i in range(16):
  folder=ROOT/f'session-{i:02}';folder.mkdir();(folder/'eph').mkdir();baseline=i in (0,1,8,9);rtk=i<8
  exe=A.baseline if baseline else A.candidate
  text=f'GNSS_PMode = {6 if rtk else 2};\nGNSS_SatSYS = SYSGPS|SYSGAL|SYSBDS;\nGNSS_ARMode = 0;\nGNSS_RoveSampleTime = 1;\nGNSS_BaseSampleTime = 1;\nGNSS_bOutputLOG = ON;\nGNSS_bOutputULog = OFF;\nGNSS_bOutputNMEA = OFF;\nGNSS_bRecordRTCM3 = OFF;\nIPSClient_bStatusLog = ON;\nIPSClient_StopFile = {folder}/stop.request;\nGNSS_ShareEPHPath = {folder}/eph;\nRTIE_bSendSolDB = OFF;\nRTIE_bSiteInfoFromDB = OFF;\n'
  for role in ('ROVE','BASE') if rtk else ('ROVE',):
   text+=f'{role}_NTRIP_CasterHost = 127.0.0.1;\n{role}_NTRIP_Port = {port};\n{role}_NTRIP_Mountpoint = {i}/{role};\n{role}_NTRIP_Format = RTCM3;\n{role}_NTRIP_DataType = OBS|EPH;\n'
  if not rtk:text+=f'PRODUCT_NTRIP_Type = SSR;\nPRODUCT_NTRIP_CasterHost = 127.0.0.1;\nPRODUCT_NTRIP_Port = {port};\nPRODUCT_NTRIP_Mountpoint = {i}/PRODUCT;\nPRODUCT_NTRIP_DataType = ORB|CLK|CODE_OSB|PHASE_OSB;\nGNSS_bUsePPPOSB = ON;\nGNSS_ATXFile = {SOURCE.parent/'COMMON/antenna.atx'};\n'
  opt=folder/'run.opt';opt.write_text(text);env={k:v for k,v in os.environ.items() if not k.startswith('IPSPOS_DIAG_')}
  if not baseline:env.update(IPSPOS_DIAG_SATELLITE_DIR=str(folder),IPSPOS_DIAG_SATELLITE_RUN_ID=f'barrier-{i}')
  log=(folder/'console.txt').open('wb');p=subprocess.Popen([str(exe),str(opt)],cwd=folder,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
  sessions.append(dict(index=i,folder=folder,p=p,console=log,rows=[],offset=0,pending=b'',baseline=baseline))
 wait_for(lambda:len(connections)==32,'all connections',30)
 threading.Thread(target=heartbeat,daemon=True).start()
 for i in range(16):
  send(i,'ROVE',nav)
  if i<8:send(i,'BASE',nav)
 wait_for(accepted,'navigation decoded')
 epoch=0;started=time.monotonic();last_report=-60
 while epoch<len(groups) and (time.monotonic()-started<A.seconds or epoch<60):
  elapsed=time.monotonic()-started;selected[0]=2 if elapsed<A.seconds/2 else 10
  if A.seconds>=1800:
   temporary=sessions[10]['folder']/'satellites.tmp'
   if elapsed>=A.seconds-120 and elapsed<A.seconds-100 and not fault:
    temporary.mkdir(exist_ok=True);fault=True
   if elapsed>=A.seconds-100 and temporary.is_dir():temporary.rmdir()
   if elapsed>=A.seconds-60:selected[0]=-1
   if elapsed>=A.seconds-50 and released is None:released=len(samples)
   if released is not None:assert len(samples)==released,'publishing after lease release'
  for i in range(16):send(i,'BASE' if i<8 else 'PRODUCT',groups[epoch] if i<8 else products[epoch])
  wait_for(accepted,f'base/product accepted epoch {epoch}')
  for i in range(16):send(i,'ROVE',groups[epoch])
  wait_for(lambda:all(len(rows(s))>=epoch+1 for s in sessions),f'solved epoch {epoch}')
  for start in (0,8):
   reference=sessions[start]['rows'][epoch]
   for s in sessions[start+1:start+8]:
    assert s['rows'][epoch]==reference,f'numerical difference session {s["index"]} epoch {epoch}\n{reference}\n{s["rows"][epoch]}'
  epoch+=1
  if elapsed-last_report>=60:
   resources.append(dict(seconds=elapsed,privateBytes=[memory(s['p'].pid) for s in sessions]));(ROOT/'resources.json').write_text(json.dumps(resources,indent=2))
   progress=dict(seconds=elapsed,epochs=epoch,snapshots=len(samples),equal=True);(ROOT/'progress.json').write_text(json.dumps(progress));print(json.dumps(progress),flush=True);last_report=elapsed
 summary=dict(seconds=time.monotonic()-started,epochs=epoch,allEqual=True,sessions=[dict(index=s['index'],baseline=s['baseline'],rows=len(rows(s)),sha256=hashlib.sha256('\n'.join(s['rows']).encode()).hexdigest()) for s in sessions])
 summary.update(droppedFrames=0,captureP95Ms=sorted(x['captureMs'] for x in samples)[int(len(samples)*.95)],maxSnapshotBytes=max(x['bytes'] for x in samples),writeFailureInjected=fault,unsubscribeVerified=released is not None)
 assert summary['captureP95Ms']<=1,'capture exceeded 1 ms P95'
 if fault:assert any(x['at']>A.seconds-100 and x['at']<A.seconds-60 for x in samples),'publisher did not recover'
 (ROOT/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(summary),flush=True)
finally:
 stop.set()
 for s in sessions:(s['folder']/'stop.request').write_text('stop')
 for s in sessions:
  try:s['p'].wait(timeout=8)
  except subprocess.TimeoutExpired:s['p'].kill();s['p'].wait()
  s['console'].close()
 done.set();server.shutdown();server.server_close();(ROOT/'samples.json').write_text(json.dumps(samples,indent=2))
 (ROOT/'process-exits.json').write_text(json.dumps([s['p'].returncode for s in sessions]))
 if 'summary' in globals():assert all(s['p'].returncode==0 for s in sessions),'client did not stop cleanly'
