#!/usr/bin/env python3
"""Native Appium taps/keyboard in the isolated common-memory iPhone fixture only."""
import json, pathlib, time, urllib.request, urllib.error, subprocess, sys
session=json.loads(pathlib.Path(sys.argv[1]).read_text())
fixture=json.loads(pathlib.Path(sys.argv[2]).read_text())
assert session['server'] in ('http://127.0.0.1:4723','http://127.0.0.1:4725') and fixture['bundleId']=='com.intenet.agentstoz.workspacetest'
base=session['server']+'/session/'+session['sessionId']; key='element-6066-11e4-a52e-4f735466cecf'
evidence=pathlib.Path(fixture['evidence']); journeys=[]; controls=[]
def call(path,data=None,timeout=30):
 request=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 try: return json.load(urllib.request.urlopen(request,timeout=timeout))['value']
 except urllib.error.HTTPError as e: raise RuntimeError(e.read().decode()[:500])
def active():
 assert call('/execute/sync',{'script':'mobile: activeAppInfo','args':[]})['bundleId']==fixture['bundleId'], 'Foreground changed; refuses to touch another app'
def elements(label,kind='Button',prefix=False):
 active()
 op='BEGINSWITH' if prefix else '=='
 return call('/elements',{'using':'-ios predicate string','value':f'type == "XCUIElementType{kind}" AND label {op} '+json.dumps(label,ensure_ascii=False)})
def viewport():
 active();views=call('/elements',{'using':'-ios predicate string','value':'type == "XCUIElementTypeWebView"'});assert views
 return call('/element/'+views[0][key]+'/rect')
def swipe(up=True):
 active()
 r=viewport();lo,hi=int(r['y']+r['height']*.25),int(r['y']+r['height']*.8);start,end=(hi,lo) if up else (lo,hi)
 call('/actions',{'actions':[{'type':'pointer','id':'touch','parameters':{'pointerType':'touch'},'actions':[{'type':'pointerMove','duration':0,'x':214,'y':start},{'type':'pointerDown','button':0},{'type':'pause','duration':100},{'type':'pointerMove','duration':400,'x':214,'y':end},{'type':'pointerUp','button':0}]}]});time.sleep(.15)
def find(label,kind='Button',prefix=False):
 for _ in range(18):
  es=elements(label,kind,prefix)
  if es:
   eid=es[0][key];rect=call('/element/'+eid+'/rect');center=rect['y']+rect['height']/2
   v=viewport();bottom=v['y']+v['height']-12
   if v['y']+12<center<bottom: return eid,rect
   swipe(center>=bottom)
  else: time.sleep(.2)
 raise RuntimeError('Cannot reach fixture control '+label)
def click(label,kind='Button',prefix=False):
 active();eid,r=find(label,kind,prefix);active();call('/element/'+eid+'/click',{});time.sleep(.15)
 if kind=='Button':controls.append({'label':label,'height':r['height']})
def fill(label,text,kind='TextField'):
 active();eid,_=find(label,kind);active();call('/element/'+eid+'/click',{});active();call('/element/'+eid+'/clear',{});active();call('/element/'+eid+'/value',{'text':text,'value':list(text)},timeout=60)
 active()
 try: call('/appium/device/hide_keyboard',{'strategy':'pressKey','key':'Done'})
 except RuntimeError:
  done=elements('완료')+elements('Done')
  if done: call('/element/'+done[0][key]+'/click',{})
  else: raise RuntimeError('Keyboard has no dismiss control')
 time.sleep(.15)
def wait_text(text):
 import xml.etree.ElementTree as E
 for _ in range(40):
  active()
  if call('/elements',{'using':'-ios predicate string','value':'(type == "XCUIElementTypeStaticText" OR type == "XCUIElementTypeButton") AND label CONTAINS '+json.dumps(text,ensure_ascii=False)}):return
  document=call('/source'); combined=''.join(e.get('label','') for e in E.fromstring(document).iter() if e.get('type') in ('XCUIElementTypeStaticText','XCUIElementTypeButton'))
  if ''.join(text.split()) in ''.join(combined.split()):return
  time.sleep(.2)
 raise RuntimeError('Fixture text missing '+text)
def api(path,post=False):
 r=urllib.request.Request(fixture['url']+path,data=b'{}' if post else None,headers={'Content-Type':'application/json'})
 return json.load(urllib.request.urlopen(r,timeout=10))
def start_create():
 if elements('목록으로 돌아가기'):click('목록으로 돌아가기')
 click('공통기억 만들기')
def create(name,members):
 start_create();fill('공통기억 이름',name)
 for m in members:click(m,'Switch',prefix=True)
 click('공통기억 만들기');wait_text(name+' 관리·수정')
active()
if elements('공통기억 관리'):click('공통기억 관리')
create('운전게임',['등록 A 장기기억','등록 B 장기기억'])
click('직접 기억 항목 작성·수정',prefix=True)
fill('공통 항목 제목','시간에 독립적인 조작')
fill('공통 항목 내용','운전 조작은 프레임 속도와 독립적으로 검증했다.','TextView')
click('공통 항목 저장');wait_text('시간에 독립적인 조작')
journeys.append('physical-keyboard-independent-memory-entry')
create('아이폰 네이티브 앱',['등록 B 장기기억','등록 C 장기기억'])
stats=api('/fixture/stats');assert len(stats['groups'])==2
game,ios=[next(g for g in stats['groups'] if g['state']['name']==n) for n in ['운전게임','아이폰 네이티브 앱']]
def knowledge(group):return group['state']['portableKnowledge']['current']
assert set(m['memoryId'] for m in knowledge(game)['members'])&set(m['memoryId'] for m in knowledge(ios)['members'])=={'22222222-2222-4222-8222-222222222222'}
assert '프레임 속도' in knowledge(game)['entries'][0]['body']
journeys.append('independent-memory-ids-overlapping-long-term-memory-links')
assert not elements('이 기기의 누락 프로젝트 확인'), 'Project cloning must be outside the common memory panel'
click('별도 프로젝트 가져오기 시험 화면');click('이 기기의 누락 프로젝트 확인')
eid,_=find('공통기억 프로젝트 작업 루트','Other');call('/element/'+eid+'/click',{})
root_options=elements('격리된 시험 작업 루트','PickerWheel')
if root_options:call('/element/'+root_options[0][key]+'/value',{'value':['격리된 시험 작업 루트'],'text':'격리된 시험 작업 루트'})
else:
 options=elements('격리된 시험 작업 루트','Other')+elements('격리된 시험 작업 루트','Button')
 assert options;call('/element/'+options[-1][key]+'/click',{})
try:call('/appium/device/hide_keyboard',{'strategy':'pressKey','key':'Done'})
except RuntimeError:
 done=elements('완료')+elements('Done')
 if done:call('/element/'+done[0][key]+'/click',{})
click('등록 상태·추가 계획 확인');wait_text('추가 가능 2')
api('/fixture/restore-failure',True);click('추가 가능한 프로젝트 모두 가져오기');wait_text('추가를 완료하지 못했습니다. 같은 요청으로 결과를 확인하세요.')
assert api('/fixture/stats')['clones']==1
click('같은 프로젝트 추가 결과 확인');click('추가 가능한 프로젝트 모두 가져오기');wait_text('추가 가능한 프로젝트의 처리가 끝났습니다')
stats=api('/fixture/stats');assert stats['clones']==2 and len(set(stats['registered']))==2
journeys.append('physical-separate-project-import-two-clones-partial-failure-exact-resume')
click('기억 시험 화면으로 돌아가기')
fill('무엇을 만들까요?','SwiftUI 아이폰 앱','TextView');click('목표에 맞는 공통기억 추천');wait_text('현재 목표의 검색 조건에 맞는 게시된 공통기억 후보가 없습니다.')
journeys.append('empty-unpublished-memory-is-not-a-recommendation-pass')
keyboard_before_restart=json.loads((evidence/'result.json').read_text())
assert keyboard_before_restart['keyboardShown']
# A process restart recreates the shipped memory panel and reads saved cloud memory.
call('/execute/sync',{'script':'mobile: terminateApp','args':[{'bundleId':fixture['bundleId']}]});call('/execute/sync',{'script':'mobile: activateApp','args':[{'bundleId':fixture['bundleId']}]});time.sleep(1)
click('공통기억 관리');wait_text('아이폰 네이티브 앱');assert len(api('/fixture/stats')['groups'])==2
journeys.append('physical-process-restart-retains-independent-memory-links')
# The native probe reports geometry and keyboard from the real WKWebView.
result=json.loads((evidence/'result.json').read_text());geometry=json.loads(result['geometry'])
assert keyboard_before_restart['keyboardShown'] and geometry['scale']==1 and geometry['scrollWidth']==geometry['width']
assert all(h>=16 for h in geometry['inputSizes']) and all(c['height']>=44 for c in controls)
(evidence/'ui-journeys.json').write_text(json.dumps({'actualIPhone':True,'isolatedFixture':True,'journeys':journeys,'controls':controls,'geometry':geometry},ensure_ascii=False,indent=2));(evidence/'ui-journeys.json').chmod(0o600)
done=evidence/'common-done.json';done.write_text('{}');done.chmod(0o600)
subprocess.run(['xcrun','devicectl','device','copy','to','--device',fixture['device'],'--domain-type','appDataContainer','--domain-identifier',fixture['bundleId'],'--source',str(done),'--destination','Documents/common-done.json'],check=True,capture_output=True,timeout=30)
print(json.dumps({'passed':True,'actualIPhone':True,'journeys':journeys},ensure_ascii=False),flush=True)
