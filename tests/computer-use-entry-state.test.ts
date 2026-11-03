import {test,expect} from 'bun:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ComputerUseEntryOverview,ComputerUseHelperStatus} from '../src/ComputerUsePanel';
import {computerUseEntryRows,computerUseStatusCurrent,COMPUTER_USE_STATUS_MAX_AGE_MS} from '../src/computerUseEntryState';
import {computerUseRemotePrepared,computerUseRemoteStateText,computerUseRemoteView} from '../src/ComputerUseScopeControls';

const now=1_800_000_000_000;
function ready(){return {success:true,native:{success:true,accessibility:true,secureInput:false},scoped:{native:{success:true,scopeProtocolVersion:2,accessibility:true,screenRecording:true,secureInput:false,standing:{since:now-1000},operations:['scope-observe','scope-capture','scope-click','scope-key','scope-type-text']},pending:[],grants:[]},access:{enabled:true,scope:{kind:'desktop'},standing:{since:now-1000}},remote:{accepting:true,allowRemote:true,nativeAuthorized:true,profileReady:true,settingsUnreadable:false,noticeShown:true}};}
const remote=(s:Record<string,any>)=>computerUseEntryRows(s,true,now).find(r=>r.id==='remote')!;

test('only a recent complete successful read can display positive readiness',()=>{
 expect(computerUseStatusCurrent('current',now,now)).toBe(true);
 expect(computerUseStatusCurrent('current',now,now+COMPUTER_USE_STATUS_MAX_AGE_MS-1)).toBe(true);
 for(const [phase,at,clock] of [['failed',now,now],['loading',null,now],['current',now,now+COMPUTER_USE_STATUS_MAX_AGE_MS],['current',now+1,now]] as const)expect(computerUseStatusCurrent(phase,at,clock)).toBe(false);
 const html=renderToStaticMarkup(React.createElement(ComputerUseEntryOverview,{rows:computerUseEntryRows(ready(),false,now),busy:false,onNext:()=>{throw Error('render never acts');}}));
 expect(html).toContain('현재 상태 확인 필요');expect(html).not.toContain('받을 준비됨');expect(html).not.toContain('요청 수신 켜짐');
 expect(renderToStaticMarkup(React.createElement(ComputerUseHelperStatus,{state:ready(),nativeState:null,statusCurrent:false}))).not.toContain('도우미 연결됨');
});
test('local request readiness, standing allowance and remote readiness are separate facts',()=>{
 const state=ready(),rows=computerUseEntryRows(state,true,now);
 expect(rows.map(r=>r.id)).toEqual(['local','standing','remote','registration']);expect(rows[0]).toMatchObject({label:'요청 수신 켜짐',action:'scope'});expect(rows[1]).toMatchObject({label:'켜짐',action:'control'});expect(rows[2]).toMatchObject({label:'받을 준비됨',ready:true});
 expect(rows[3]).toMatchObject({label:'등록 창에서 확인',ready:false,action:'registration'});
 expect(computerUseRemotePrepared(computerUseRemoteView(state,now))).toBe(true);
});
test('a switched-on receiving setting cannot mask missing standing, profile or native authorization',()=>{
 const standing=ready();delete (standing.access as any).standing;standing.scoped.native.standing=null as any;
 expect(remote(standing)).toMatchObject({label:'켜짐 · 받을 준비 필요',ready:false,action:'control'});
 const profile=ready();profile.remote.profileReady=false;expect(remote(profile)).toMatchObject({ready:false,action:'refresh'});expect(remote(profile).detail).toContain('공유 총괄 폴더');
 const native=ready();native.remote.nativeAuthorized=false;expect(remote(native)).toMatchObject({ready:false,action:'registration'});
 const unknown=ready();delete (unknown.remote as any).nativeAuthorized;expect(remote(unknown)).toMatchObject({label:'수신 권한 확인 필요',ready:false});
 const unknownProfile=ready();delete (unknownProfile.remote as any).profileReady;expect(remote(unknownProfile).ready).toBe(false);
});
test('current permission failure, secure input and recovery review never appear as remote ready',()=>{
 const denied=ready();denied.scoped.native.screenRecording=false;expect(remote(denied).ready).toBe(false);
 const secure=ready();secure.scoped.native.secureInput=true;expect(remote(secure)).toMatchObject({label:'보안 입력 중',ready:false});
 const pending=ready();(pending.remote as any).receptionReview={state:'pending'};expect(remote(pending)).toMatchObject({label:'승인 대기',ready:false,action:'control'});
 const unreadable=ready();unreadable.remote.settingsUnreadable=true;expect(remote(unreadable)).toMatchObject({label:'수신 상태 확인 필요',ready:false});
 const unsupported=ready();unsupported.remote.accepting=false;delete (unsupported.remote as any).nativeAuthorized;delete (unsupported.access as any).standing;expect(remote(unsupported).detail).toContain('서명된 Mac 앱');
 const off=ready();off.remote.allowRemote=false;expect(remote(off)).toMatchObject({label:'꺼짐',action:'remote',ready:false});
});
test('the remote status line distinguishes setting-on from preparation and unknown permissions',()=>{
 const state=ready();expect(computerUseRemoteStateText(computerUseRemoteView(state,now)!)).toContain('받을 준비됨');
 delete (state.remote as any).nativeAuthorized;expect(computerUseRemoteStateText(computerUseRemoteView(state,now)!)).toContain('확인 필요');
 expect(computerUseRemotePrepared(computerUseRemoteView(state,now))).toBe(false);
});
test('next-step controls do not claim feature enrollment or external-app effort support',()=>{
 const html=renderToStaticMarkup(React.createElement(ComputerUseEntryOverview,{rows:computerUseEntryRows(ready(),true,now),busy:false,onNext:()=>{}}));
 expect(html).toContain('대화 참여와 기능 등록은 별도');expect(html).toContain('등록·승인 경로 보기');expect(html).not.toContain('등록 완료');expect(html).not.toContain('에포트 변경 지원');
 for(const action of ['local','standing','remote','registration'])expect(html).toContain('computer-use-entry-'+action);
});
