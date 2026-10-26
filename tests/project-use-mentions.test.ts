import {expect,test} from 'bun:test';
import {projectMentionChoices,projectMentionKey,useReferenceId,parseUseReferenceId,normalizeUseServices} from '../src/projectUseMention';
import {workroomMentionCandidates,suggestedWorkroomTargets} from '../src/workroomProjectMention';
import {communityMentionState,communityReferencesFor} from '../src/workroomCommunityMention';
import {resolveConversationTargetAlias} from '../src/conversationTargetAlias';
import {normalizeAiTerminalRequest} from '../src/aiTerminalProtocol';
import {normalizeAgentRuntimeTargetsResponse} from '../src/agentRuntimeApiContract';
import {AGENT_RUNTIME_PROTOCOL_VERSION} from '../src/agentRuntimeProtocol';
import {SERVICE_USE_MCP_TOOL} from '../src/serviceUseMcp';

const projects=[{targetId:'project-shadowloop',label:'ShadowLoop',useServices:['default']},{targetId:'project-other-app',label:'Other app'}];
test('enabled USE appears beside its DEV in both @ and # without another project ID',()=>{
 for(const marker of ['@','#']){
  const rows=workroomMentionCandidates(marker+'Shadow',projects);
  expect(rows.map(p=>p.label)).toEqual(['ShadowLoop','ShadowLoop-USE']);
  expect(new Set(rows.map(p=>p.targetId)).size).toBe(1);
  expect(new Set(rows.map(projectMentionKey)).size).toBe(2);
  expect(rows[1]).toMatchObject({executionRole:'use',serviceKey:'default'});
 }
 expect(projectMentionChoices(projects).some(p=>p.label==='Other app-USE')).toBe(false);
 expect(projectMentionChoices([{...projects[0]!,scope:'worktree'}]).map(p=>p.label)).toEqual(['ShadowLoop']);
 expect(projectMentionChoices(projectMentionChoices(projects))).toEqual(projectMentionChoices(projects));
 expect(suggestedWorkroomTargets('ShadowLoop-USE로 자료 만들어줘',projects).map(p=>p.label)).toEqual(['ShadowLoop-USE']);
 expect(suggestedWorkroomTargets('#ShadowLoop-USE 참고',projects)).toEqual([]);
});
test('another device offers its USE only as a # reference, and # retains its parent grant and service identity',()=>{
 // A USE run happens on its own Mac under its own user; another Mac's @-route would always be refused there.
 const devices=[{deviceId:'device-two',label:'아젠투지2호',projects}];
 expect(communityMentionState('2호 @Shadow',12,{local:[],devices})?.candidates.map(p=>p.label)).toEqual(['ShadowLoop']);
 expect(communityMentionState('2호 #Shadow',12,{local:[],devices})?.candidates.map(p=>p.label)).toEqual(['ShadowLoop','ShadowLoop-USE']);
 // The same for a Mac driven from elsewhere: its own list arrives as `local`.
 expect(communityMentionState('@Shadow',7,{local:projects,devices:[],localRunsUse:false})?.candidates.map(p=>p.label)).toEqual(['ShadowLoop']);
 expect(communityMentionState('#Shadow',7,{local:projects,devices:[],localRunsUse:false})?.candidates.map(p=>p.label)).toEqual(['ShadowLoop','ShadowLoop-USE']);
 expect(communityMentionState('@Shadow',7,{local:projects,devices:[]})?.candidates.map(p=>p.label)).toEqual(['ShadowLoop','ShadowLoop-USE']);
 const token='#아젠투지2호/ShadowLoop-USE';
 const result=communityReferencesFor([{deviceId:'device-two',targetId:projects[0]!.targetId,label:'ShadowLoop-USE',token,executionRole:'use',serviceKey:'default'}],token,'device-two');
 expect(result.references).toEqual([useReferenceId(projects[0]!.targetId)]);
 expect(parseUseReferenceId(result.references[0]!)).toEqual({targetId:projects[0]!.targetId,serviceKey:'default'});
 expect(communityReferencesFor([{deviceId:'device-two',targetId:projects[0]!.targetId,label:'ShadowLoop-USE',token,executionRole:'use'}],token,'another-device').references).toEqual([]);
});
test('natural MCP aliases select USE while a literal registered name keeps its existing meaning',()=>{
 const rows=[{id:projects[0]!.targetId,name:'ShadowLoop'}];
 for(const alias of ['ShadowLoop USE','ShadowLoop-USE','@ShadowLoop-USE','ShadowLoop 운영']) expect(resolveConversationTargetAlias(alias,rows)).toMatchObject({projectId:rows[0]!.id,executionRole:'use'});
 expect(resolveConversationTargetAlias('ShadowLoop',rows)).not.toHaveProperty('executionRole');
 expect(resolveConversationTargetAlias('ShadowLoop-USE',[...rows,{id:'literal-project',name:'ShadowLoop-USE'}])).toMatchObject({projectId:'literal-project'});
});
test('USE reference IDs are accepted only as references, never as a DEV terminal target',()=>{
 const reference=useReferenceId(projects[0]!.targetId);
 expect(normalizeAiTerminalRequest({requestId:'request-reference',operation:'input',sessionId:'session-source',data:'Read only\r',references:[reference]}).references).toEqual([reference]);
 expect(()=>normalizeAiTerminalRequest({requestId:'request-reference',operation:'start',targetId:reference,agent:'codex'})).toThrow();
 for(const value of ['use:../private:default','use:project-shadowloop:../secret'])expect(()=>parseUseReferenceId(value)).toThrow();
 expect(()=>normalizeUseServices(['default','default'])).toThrow();
});
test('target DTO accepts optional bounded USE keys and preserves legacy target DTO shape',()=>{
 const target={targetId:projects[0]!.targetId,projectTargetId:projects[0]!.targetId,label:'ShadowLoop',scope:'main' as const,branch:'main',locked:false,worktreeCapable:true};
 const wrap=(target:unknown)=>({protocolVersion:AGENT_RUNTIME_PROTOCOL_VERSION,targets:[target],complete:true});
 expect(normalizeAgentRuntimeTargetsResponse(wrap(target)).targets[0]).toEqual(target);
 expect(normalizeAgentRuntimeTargetsResponse(wrap({...target,useServices:['default']})).targets[0]!.useServices).toEqual(['default']);
 expect(()=>normalizeAgentRuntimeTargetsResponse(wrap({...target,useServices:['../private']}))).toThrow();
});
test('MCP discovery describes natural USE requests and all six exact bounded call shapes',()=>{
 const text=JSON.stringify(SERVICE_USE_MCP_TOOL);
 expect(text).toContain('ShadowLoop USE로 자료 만들어줘');
 expect(text).toContain('agentstoz_use_resolve_target');
 for(const tool of ['materials.generate','materials.reuse','audio.prepare','operation.status','operation.cancel','phone.deliver'])expect(text).toContain(tool);
 expect(text).toContain('additionalProperties');expect(text).toContain('same requestId');
});
