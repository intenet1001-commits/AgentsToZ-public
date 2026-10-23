import {expect,test} from 'bun:test';
import {automaticSaveNotices} from '../src/automaticSaveNotices';
import {workroomAutomaticSaves,validWorkroomSessionStatus,withWorkroomAutomaticSaveMessage} from '../src/workroomSessionStatus';
import type {CodexAutoRememberSessionStatus} from '../src/codexAutoRememberContract';
const now=Date.parse('2026-10-23T01:00:00Z');
const savedAt='2026-10-23T00:00:00Z';
const session={sourceAgent:'claude',sessionId:'native-conversation',usedPercent:71,observedAt:savedAt,nextThreshold:75,phase:'saved',projectId:'project-one',projectName:'프로젝트',lastCheckpointAt:savedAt,lastCheckpointThreshold:70,backupWarning:null,message:'local saved'} as CodexAutoRememberSessionStatus;
test('only actual local receipts produce threshold notices; enabled, waiting and in-flight states do not',()=>{
  const value=automaticSaveNotices({sessions:[session]},now);expect(value[0]).toMatchObject({kind:'memory',threshold:70,agent:'Claude',savedAt});
  for(const phase of ['observing','waiting-for-turn','saving','recovery-required'] as const)expect(automaticSaveNotices({sessions:[{...session,phase,lastCheckpointAt:null,lastCheckpointThreshold:null}]},now)).toEqual([]);
  for(const lastCheckpointAt of ['invalid','2026-10-24T00:00:00Z','2026-09-01T00:00:00Z'])expect(automaticSaveNotices({sessions:[{...session,lastCheckpointAt}]},now)).toEqual([]);
});
test('Hermes and Antigravity get actual fragment notices with expiry, never a fabricated 70% memory save',()=>{
  for(const agent of ['hermes','agy']){
    const recoveryCheckpoints=[{id:'a'.repeat(64),agent,projectName:'격리 QA',savedAt,expiresAt:'2026-10-30T00:00:00Z'}];
    expect(automaticSaveNotices({sessions:[],recoveryCheckpoints},now)[0]).toMatchObject({kind:'recovery-fragment',threshold:null});
    expect(automaticSaveNotices({sessions:[],recoveryCheckpoints:[{...recoveryCheckpoints[0],expiresAt:savedAt}]},now)).toEqual([]);
  }
});
test('Workroom needs the exact provider session, agent and project; neighbouring saves cannot authorize a success notice',()=>{
  const input={providerId:session.sessionId,agent:'claude',projectId:'project-one',checkpoints:[session],recoveries:[{sessionId:session.sessionId,agent:'claude',createdAt:Date.parse(savedAt),expiresAt:now+10000}]};
  const good=workroomAutomaticSaves(input,now);expect(good).toHaveLength(2);expect(good[0]?.threshold).toBe(70);
  for(const patch of [{providerId:null},{providerId:'other-session'},{agent:'codex'},{projectId:'project-other',recoveries:[]}])expect(workroomAutomaticSaves({...input,...patch},now)).toEqual([]);
  const base={sessionId:'workroom-session',context:{usedPercent:null,observedAt:null,source:'unavailable'},lastSavedAt:null,initialized:true,save:{requestId:null,state:'idle',localSaved:false,backupSaved:false,message:''}};
  // Current and old strict clients accept the unchanged DTO. Automatic receipts
  // decorate its existing message, never create manual save/close authority.
  expect(validWorkroomSessionStatus({...base,save:withWorkroomAutomaticSaveMessage(base.save,good)})).toBe(true);
  const decorated=withWorkroomAutomaticSaveMessage(base.save,good);expect(decorated.message).toContain('70%');expect(decorated.message).toContain('복구 조각');expect(decorated.localSaved).toBe(false);expect(decorated.requestId).toBeNull();
  expect(validWorkroomSessionStatus({...base,automaticSaves:good})).toBe(false);
  for(const state of ['saving','unconfirmed','failed','recovery-required','not-admitted']){const save={...base.save,state,message:'원래 확인이 필요한 결과'};expect(withWorkroomAutomaticSaveMessage(save,good)).toEqual(save);}
  expect(decorated.message.length).toBeLessThanOrEqual(500);
});
