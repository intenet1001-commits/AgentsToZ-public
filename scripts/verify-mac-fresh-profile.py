#!/usr/bin/env python3
"""Explicit artifact smoke: temporary HOME/data, no login or external network.

Requires macOS, a built AgentsToZ app and sandbox-exec (test policy only).
The disposable profile remains at the report's HOME for diagnostic inspection.
Only fixture project commands are started; all are stopped before exit.
"""
import argparse,os,pathlib,tempfile,subprocess,json,time,socket,secrets,urllib.request,urllib.error,hashlib,signal,plistlib
parser=argparse.ArgumentParser(description='Run the installed compiled sidecar in an empty temporary profile, never a substitute for fresh macOS GUI installation testing.')
parser.add_argument('--app',required=True,type=pathlib.Path)
parser.add_argument('--output',required=True,type=pathlib.Path)
args=parser.parse_args()
app=args.app.resolve(strict=True)
if app.name!='AgentsToZ_byCS.app':raise SystemExit('Expected AgentsToZ_byCS.app')
subprocess.run(['/usr/bin/codesign','--verify','--deep','--strict',str(app)],check=True,capture_output=True)
info=plistlib.loads((app/'Contents/Info.plist').read_bytes())
if info.get('CFBundleIdentifier')!='com.intenet.agentstozbycs':raise SystemExit('Unexpected bundle ID')
out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(tempfile.mkdtemp(prefix='atz-fresh-profile-'));home=root/'home';home.mkdir();data=home/'Library/Application Support/com.portmanager.portmanager';data.mkdir(parents=True);project=home/'projects/first-project';project.mkdir(parents=True)
sidecar=app/'Contents/Resources/resources/agentstoz-api-sidecar'
cap=secrets.token_hex(32)
env={k:os.environ[k] for k in ('TMPDIR','USER','LOGNAME') if k in os.environ}
env.update(HOME=str(home),PATH='/usr/bin:/bin:/usr/sbin:/sbin',LANG='en_US.UTF-8',APP_DATA_DIR=str(data),NODE_ENV='test',PORTMGR_BUNDLED_SIDECAR='1',PORTMGR_PARENT_PID=str(os.getpid()),PORTMGR_ONBOARDING_CAPABILITY=cap,PORTMGR_AGENT_RUNTIME_CAPABILITY=cap,AGENTSTOZ_SKIP_HERMES_SYNC='1',AGENTSTOZ_SKIP_OUTPUT_STYLE_SYNC='1',AGENTSTOZ_SKIP_CONTROL_BOOTSTRAP='1',AGENTSTOZ_SKIP_MCP_CONNECTION_SYNC='1')
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env['API_PORT']=str(port)
# Preserve real user settings; fixture commands cannot send traffic outside loopback.
policy='(version 1)(allow default)(deny network*)(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))'
checks=[];child=None;running=False
report={'kind':'installed-native-sidecar-isolated-empty-profile','version':info['CFBundleShortVersionString'],'sidecarSha256':hashlib.sha256(sidecar.read_bytes()).hexdigest(),'freshOSUser':False,'guiTested':False,'testFlightInstalled':False,'externalNetwork':'denied by sandbox-exec test policy','home':str(home),'tests':checks}
def request(path,body=None,headers=None):
 h={'Content-Type':'application/json'};h.update(headers or {})
 req=urllib.request.Request('http://127.0.0.1:'+str(port)+path,data=None if body is None else json.dumps(body).encode(),headers=h)
 try:
  with urllib.request.urlopen(req,timeout=20) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
def check(name,ok,detail=None):
 checks.append({'name':name,'passed':bool(ok),**({'detail':detail} if detail is not None else {})});print(name+': '+str(bool(ok)),flush=True)
 if not ok:raise AssertionError(name+': '+str(detail))
def start():
 log=open(out/'fresh-sidecar.log','ab',buffering=0)
 p=subprocess.Popen(['/usr/bin/sandbox-exec','-p',policy,str(sidecar)],cwd=root,env=env,stdout=log,stderr=log,start_new_session=True)
 log.close()
 for _ in range(200):
  if p.poll() is not None:raise RuntimeError('sidecar exited: '+str(p.returncode))
  try:
   status,j=request('/api/health')
   if status==200 and j.get('service')=='agentstoz-api':return p
  except (OSError,ValueError):pass
  time.sleep(.1)
 p.terminate();raise RuntimeError('sidecar health timeout')
def stop(p):
 p.terminate()
 try:p.wait(timeout=10)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
try:
 child=start();check('compiled-sidecar-first-boot',True)
 s,j=request('/api/ports');check('fresh-project-list-empty',s==200 and j==[],j)
 s,j=request('/api/onboarding/status');check('fresh-device-requires-explicit-setup',s==200 and j.get('stage') == 'fresh' and j.get('recommendedAction') == 'choose-first-or-additional' and j.get('hasSupabaseConfig') is False and j.get('hasDeviceIdentity') is False,j)
 s,j=request('/api/ports',headers={'Origin':'https://untrusted.example'});check('untrusted-browser-refused',s==403)
 s,j=request('/api/onboarding/mac-setup',{'operation':'status'});check('native-management-without-capability-refused',s==403)
 s,j=request('/api/onboarding/mac-setup',{'operation':'status'},{'x-agentstoz-onboarding-capability':cap});check('fresh-install-queue-readable',s==200 and j.get('success') is True,j)
 s,j=request('/api/agent-runtime/platform-cli',{'operation':'list'},{'x-agentstoz-agent-runtime-capability':cap,'Origin':'tauri://localhost'});check('fresh-profile-no-saved-accounts',s==200 and all(x.get('source')=='default' and x.get('identity') is None for x in j.get('accounts',[])) and not j.get('deviceDefaults'),j)
 command='printf "started\\n" >> run-marker; exec /bin/sleep 120'
 record={'id':'fresh-native-project','name':'새 Mac 첫 프로젝트','folderPath':str(project),'commandPath':command,'category':'test','role':'dev'}
 s,j=request('/api/ports',[record]);check('first-project-save',s==200,j)
 payload={'portId':record['id'],'commandPath':command,'folderPath':str(project)}
 s,j=request('/api/execute-command',payload);running=s==200 and j.get('success') is True;check('registered-project-real-process-start',running,j)
 for _ in range(50):
  if (project/'run-marker').exists():break
  time.sleep(.1)
 check('project-command-real-output',(project/'run-marker').read_text()=='started\n')
 s,j=request('/api/stop-command',{'portId':record['id']});check('registered-project-stop',s==200 and j.get('success') is True,j);running=False
 stop(child);child=start()
 s,j=request('/api/ports');check('project-survives-sidecar-restart',s==200 and any(p.get('id')==record['id'] and p.get('folderPath')==str(project) for p in j))
 s,j=request('/api/execute-command',payload);running=s==200 and j.get('success') is True;check('project-start-after-reopen',running,j)
 for _ in range(50):
  if (project/'run-marker').read_text().count('started')==2:break
  time.sleep(.1)
 check('exactly-two-explicit-starts',(project/'run-marker').read_text().count('started')==2)
 s,j=request('/api/stop-command',{'portId':record['id']});check('project-stop-after-reopen',s==200 and j.get('success') is True,j);running=False
 s,j=request('/api/health');check('healthy-after-full-journey',s==200 and j.get('ok') is True)
 report['passed']=True
except Exception as e:
 report['passed']=False;report['failure']=str(e);print('FAIL: '+str(e),flush=True)
finally:
 if child:
  if running:
   try:request('/api/stop-command',{'portId':'fresh-native-project'})
   except Exception:pass
  stop(child)
 (out/'fresh-native-profile.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print('Evidence: '+str(out/'fresh-native-profile.json'))
 if not report.get('passed'):raise SystemExit(1)
