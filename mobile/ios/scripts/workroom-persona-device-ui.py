#!/usr/bin/env python3
"""Owned Appium session for the disposable Workroom persona app. Never targets another bundle."""
import base64,json,os,pathlib,sys,time,urllib.request,urllib.error,urllib.parse,xml.etree.ElementTree as ET

BASE=os.environ.get('PERSONA_APPIUM_SERVER','http://127.0.0.1:4723').rstrip('/')
server_url=urllib.parse.urlparse(BASE)
assert server_url.scheme=='http' and server_url.hostname=='127.0.0.1' and not server_url.username and not server_url.password and not server_url.path and not server_url.query and not server_url.fragment,'Only an owned loopback Appium server is allowed'
BUNDLE='com.intenet.agentstoz.workspacetest'
STATE=pathlib.Path(os.environ.get('PERSONA_APPIUM_STATE','/private/tmp/workroom-persona-appium.json'))
EVIDENCE=pathlib.Path(__file__).resolve().parents[1]/'build'/'workroom-persona-device'
EVIDENCE.mkdir(parents=True,exist_ok=True)
KEY='element-6066-11e4-a52e-4f735466cecf'
def request(url,data=None,timeout=120):
 req=urllib.request.Request(url,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 try:return json.load(urllib.request.urlopen(req,timeout=timeout))['value']
 except urllib.error.HTTPError as error:raise RuntimeError(error.read().decode()[:1200])
if sys.argv[1]=='create':
 assert not STATE.exists(),'An owned session record already exists; inspect or close it first'
 value=request(BASE+'/session',{'capabilities':{'alwaysMatch':{'platformName':'iOS','appium:automationName':'XCUITest','appium:udid':os.environ['PERSONA_DEVICE_UDID'],'appium:bundleId':BUNDLE,'appium:noReset':True,'appium:usePreinstalledWDA':True,'appium:useNewWDA':False,'appium:derivedDataPath':os.environ['PERSONA_WDA_DERIVED_DATA'],'appium:updatedWDABundleId':'com.intenet.agentstoz.wda.runner','appium:wdaLocalPort':int(os.environ.get('PERSONA_WDA_LOCAL_PORT','8117')),'appium:wdaLaunchTimeout':20000,'appium:wdaConnectionTimeout':20000,'appium:skipLogCapture':True,'appium:shouldTerminateApp':False,'appium:newCommandTimeout':900}}},240)
 STATE.write_text(json.dumps({'server':BASE,'sessionId':value['sessionId'],'bundleId':BUNDLE}));STATE.chmod(0o600)
 print('Owned native persona Appium session created.');sys.exit(0)
session=json.loads(STATE.read_text());assert session['server']==BASE and session['bundleId']==BUNDLE
base=BASE+'/session/'+session['sessionId']
def call(path,data=None):return request(base+path,data)
def active():assert call('/execute/sync',{'script':'mobile: activeAppInfo','args':[]})['bundleId']==BUNDLE,'Another app is foreground; stopping'
def save(stage):
 active();xml=call('/source');(EVIDENCE/(stage+'.xml')).write_text(xml)
 (EVIDENCE/(stage+'.png')).write_bytes(base64.b64decode(call('/screenshot')))
 return xml
def elements(label,kind=None):
 active();predicate=('type == '+json.dumps('XCUIElementType'+kind)+' AND ') if kind else ''
 return call('/elements',{'using':'-ios predicate string','value':predicate+'label == '+json.dumps(label,ensure_ascii=False)})
def swipe(up=True):
 active();call('/execute/sync',{'script':'mobile: swipe','args':[{'direction':'up' if up else 'down'}]});time.sleep(.2)
def click(label,kind='Button'):
 for _ in range(10):
  es=elements(label,kind)
  if es:
   element=es[0][KEY]
   rect=call('/element/'+element+'/rect');screen=call('/window/rect');center=rect['y']+rect['height']/2
   if call('/element/'+element+'/displayed') and 120<center<screen['height']-30:call('/element/'+element+'/click',{});return
   swipe(center>=120)
  else:swipe()
 raise RuntimeError('Cannot reach '+label)
def fill(label,text):
 es=elements(label,'TextView');assert es,'Missing textarea '+label
 element=es[0][KEY];call('/element/'+element+'/click',{});call('/element/'+element+'/value',{'text':text,'value':list(text)})
 try:call('/appium/device/hide_keyboard',{'strategy':'pressKey','key':'Done'})
 except RuntimeError:
  done=elements('완료','Button')+elements('Done','Button')
  if done:call('/element/'+done[0][KEY]+'/click',{})
def wait_text(text):
 for _ in range(40):
  active()
  if text in call('/source'):return
  time.sleep(.25)
 raise RuntimeError('Not visible: '+text)
if sys.argv[1]=='inspect':
 xml=save(sys.argv[2] if len(sys.argv)>2 else 'baseline')
 root=ET.fromstring(xml)
 print('\n'.join(dict.fromkeys(n.get('label','') for n in root.iter() if n.get('label')))[:4500])
elif sys.argv[1]=='journey':
 click('새 업무');fill('프로젝트에 맡길 업무','첫 업무 연결을 확인해 주세요.');click('업무 맡기기');wait_text('연결 워크룸 열기');save('task-created')
 click('지난 워크룸');click('대화 기록 · 지난 워크룸 대화 이어 열기',None);wait_text('워크룸 대화 기록 보기');save('permission-required')
 click('검증 권한 허용');click('불러오기');wait_text('지난 업무 대화');click('이어 열기');wait_text('이 Mac에서 열기');time.sleep(.6);click('이 Mac에서 열기');wait_text('재개한 세션을 선택했습니다.');save('resumed')
 print('Native first-task and saved-conversation journeys completed.')
elif sys.argv[1]=='close':
 active()
 req=urllib.request.Request(base,method='DELETE');urllib.request.urlopen(req,timeout=30).read();print('Owned Appium session closed.')
