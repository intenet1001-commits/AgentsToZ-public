import {expect,spyOn,test} from 'bun:test';
import {handleAgentsToZUseMcpRequest,AGENTSTOZ_USE_MCP_TOOLS,AGENTSTOZ_USE_MCP_INSTRUCTIONS,agentsToZUseMcpActionForTool,agentsToZUseUnconfirmedOptions} from '../agentstoz-use-mcp-server';
import {parseAgentsToZUseActionRequest} from '../src/agentstozUseControl';
import {AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE} from '../src/agentstozMcpAgentChoice';
import {agentstozMcpAgentChoice} from '../src/agentstozMcpAgentChoice';
import {hermesVariantModel} from '../src/hermesVariants';
import {teamSelectionBlock,parseTeamSelectionBlock,parseTeamMemberSelection} from '../src/teamLaunchOptions';

// An invalid endpoint would reject any attempted host access. These questions must finish without touching it.
const env={AGENTSTOZ_CONTROLLER_PORT_ID:'controller-id',AGENTSTOZ_USE_ENDPOINT:'https://not-used.invalid'};
async function call(name:string,args:unknown,environment=env){
 const r=await handleAgentsToZUseMcpRequest({id:1,method:'tools/call',params:{name:'agentstoz_use_'+name,arguments:args}},environment) as any;
 return r.result.structuredContent??JSON.parse(r.result.content[0].text);
}
test('natural-language choices ask only the missing dimension and complete preparation still executes nothing',async()=>{
 expect(await call('prepare_agent_launch',{})).toMatchObject({performed:false,selectionRequired:true,stage:'agent'});
 const claude=await call('prepare_agent_launch',{agent:'claude'});
 expect(claude).toMatchObject({performed:false,stage:'surface',draft:{agent:'claude'}});
 for(const surface of ['internal','app','orca-floating','cmux','terminal'])expect(claude.choices.some((c:any)=>c.surface===surface)).toBe(true);
 const hermes=await call('prepare_agent_launch',{agent:'hermes',surface:'internal'});
 expect(hermes).toMatchObject({performed:false,stage:'variant'});
 expect(hermes.choices.map((c:any)=>c.hermesVariant)).toEqual(['default','claude','codex']);
 expect(await call('prepare_agent_launch',{agent:'hermes',surface:'internal',hermesVariant:'codex'})).toMatchObject({ready:true,performed:false,draft:{agent:'hermes',surface:'internal',hermesVariant:'codex'},launchModel:{provider:'openai-codex'}});
 expect(await call('prepare_agent_launch',{agent:'hermes',surface:'app',hermesVariant:'claude'})).toMatchObject({ready:false,performed:false,effect:'agent-launch-refused'});
});
test('an omitted agent or Hermes configuration produces a question before any host access',async()=>{
 const base={portId:'project-id',requestId:'choice-request-123'};
 expect(await call('start_workroom_session',base)).toMatchObject({performed:false,selectionRequired:true,effect:'agent-selection-required'});
 expect(await call('open_code_app',{portId:'project-id'})).toMatchObject({performed:false,selectionRequired:true});
 expect(await call('start_workroom_session',{...base,agent:'hermes',surface:'internal'})).toMatchObject({performed:false,selectionRequired:true,stage:'variant'});
 expect(await call('create_team',{...base,title:'Team',goal:'A goal'})).toMatchObject({performed:false,missingMemberIndices:[]});
 expect(await call('create_team',{...base,title:'Team',goal:'A goal',members:[{agent:'claude',task:'one'},{task:'two'}]})).toMatchObject({performed:false,missingMemberIndices:[1]});
});
test('the exact catalog exposes bounded preparation and teaches the choice gate before truncated client instructions',()=>{
 const tool=AGENTSTOZ_USE_MCP_TOOLS.find(t=>t.name==='agentstoz_use_prepare_agent_launch')!;
 expect(tool.inputSchema.additionalProperties).toBe(false);
 expect(Object.keys(tool.inputSchema.properties as object)).toEqual(['agent','surface','hermesVariant']);
 expect(AGENTSTOZ_USE_MCP_INSTRUCTIONS.slice(0,2000)).toContain(AGENTSTOZ_MCP_AGENT_CHOICE_GUIDANCE);
});
test('the selected Hermes preset reaches the local host contract and an older host cannot silently drop it',()=>{
 const base={portId:'project-id',requestId:'variant-request-123',agent:'hermes',surface:'internal',hermesVariant:'codex'};
 const action=agentsToZUseMcpActionForTool('agentstoz_use_start_workroom_session',base,'controller-id');
 expect(action.hermesVariant).toBe('codex');
 expect(parseAgentsToZUseActionRequest(action)).toMatchObject({agent:'hermes',hermesVariant:'codex'});
 expect(agentsToZUseUnconfirmedOptions(action,{hermesVariant:'codex'})).toEqual([]);
 expect(agentsToZUseUnconfirmedOptions(action,{})).toContain('hermesVariant');
 for(const wrong of [{...action,agent:'claude'},{...action,hermesVariant:'other'},{...action,hermesVariant:null}])expect(()=>parseAgentsToZUseActionRequest(wrong)).toThrow('Hermes 실행 구성');
});
test('known agent names still require an explicit location on every MCP launch route',async()=>{
 for(const name of ['start_workroom_session','open_code_app'])for(const agent of ['codex','claude','hermes','agy']){
  expect(await call(name,{portId:'project-id',...(name==='start_workroom_session'?{requestId:'missing-location-123'}:{}),agent})).toMatchObject({performed:false,selectionRequired:true,stage:'surface'});
 }
 for(const surface of ['app','orca-floating','orca-worktree']){
  expect(await call('open_code_app',{portId:'project-id',agent:'hermes',surface})).toMatchObject({performed:false,selectionRequired:true,stage:'variant'});
  expect(await call('start_workroom_session',{portId:'project-id',agent:'claude',surface,requestId:'wrong-route-123'})).toMatchObject({performed:false,selectionRequired:false,effect:'agent-launch-refused'});
 }
 expect(await call('open_code_app',{portId:'project-id',agent:'claude',surface:'internal'})).toMatchObject({performed:false,selectionRequired:false,effect:'agent-launch-refused'});
});
test('fresh team members ask for their own missing surface and Hermes choice without contacting a host',async()=>{
 const base={portId:'project-id',requestId:'team-choice-123',title:'Team',goal:'Test choices'};
 expect(await call('create_team',{...base,members:[{agent:'claude',task:'one'}]})).toMatchObject({performed:false,stage:'surface',memberIndex:0});
 expect(await call('create_team',{...base,members:[{agent:'claude',surface:'internal',task:'one'},{agent:'hermes',surface:'internal',task:'two'}]})).toMatchObject({performed:false,stage:'variant',memberIndex:1});
 expect(await call('create_team',{...base,members:[{agent:'hermes',surface:'app',hermesVariant:'claude',task:'one'}]})).toMatchObject({performed:false,selectionRequired:false,effect:'agent-launch-refused'});
});
test('MCP Hermes aliases map once to the shared canonical model/provider and preserve exact surface',()=>{
 const base={portId:'project-id',requestId:'team-alias-123',title:'Team',goal:'Use selected model'};
 for(const variant of ['default','claude','codex'] as const){
  const args={...base,members:[{agent:'hermes',surface:'internal',hermesVariant:variant,task:'one'}]};
  expect(agentstozMcpAgentChoice('agentstoz_use_create_team',args)).toBeNull();
  const action=agentsToZUseMcpActionForTool('agentstoz_use_create_team',args,'controller-id');
  const parsed=parseAgentsToZUseActionRequest(action) as any;
  expect(parsed.team.members[0]).toMatchObject({agent:'hermes',task:'one',...(variant==='default'?{}:hermesVariantModel(variant))});
  expect(parsed.team.members[0].hermesVariant).toBeUndefined();
 }
 for(const member of [
  {agent:'claude',hermesVariant:'default'}, {agent:'hermes',hermesVariant:null},
  {agent:'hermes',hermesVariant:'other'}, {agent:'hermes',hermesVariant:'claude',model:'other'},
  {agent:'hermes',hermesVariant:'default',sessionId:'session-12345678'},
 ])expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_create_team',{...base,members:[{surface:'internal',task:'one',...member}]},'controller-id')).toThrow();
 const open=agentsToZUseMcpActionForTool('agentstoz_use_open_code_app',{portId:'project-id',agent:'hermes',surface:'app',hermesVariant:'default'},'controller-id');
 expect(open).toMatchObject({agent:'hermes',surface:'app'});
 expect(open.hermesVariant).toBeUndefined();
 expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_open_code_app',{portId:'project-id',agent:'hermes',surface:'app',hermesVariant:'claude'},'controller-id')).toThrow('현재 설정');
});
test('the button selection block carries settled defaults through MCP without another question',()=>{
 const block=teamSelectionBlock([{agent:'claude',task:'one'},{agent:'hermes',task:'two'}]);
 const raw=JSON.parse(block.match(/\n(\{[\s\S]*\})\n```/)![1]!);
 const args={portId:'project-id',requestId:'button-choice-123',title:'Team',goal:'Test',members:raw.members};
 expect(agentstozMcpAgentChoice('agentstoz_use_create_team',args)).toBeNull();
 const action=agentsToZUseMcpActionForTool('agentstoz_use_create_team',args,'controller-id') as any;
 expect(parseAgentsToZUseActionRequest(action).team).toBeDefined();
 expect(action.team.members[1].hermesVariant).toBeUndefined();
 expect(parseTeamSelectionBlock(block)).toBeDefined();
});
test('an explicit invalid surface can never become the legacy internal default',()=>{
 expect(()=>parseTeamMemberSelection({agent:'claude',surface:null,task:'one'})).toThrow('실행 위치');
 expect(()=>parseTeamMemberSelection({agent:'claude',sessionId:'session-12345678',surface:null,task:'one'})).toThrow('열린 세션');
});
test('unsupported requested options are refused before either execution or a missing-choice question',async()=>{
 for(const name of ['start_workroom_session','open_code_app'])for(const agent of [' claude ','claude\n',null,17]){
  const result=await call(name,{portId:'project-id',agent,...(name==='start_workroom_session'?{requestId:'invalid-agent-123'}:{})});
  expect(result).toMatchObject({success:false,performed:false});
  expect(result.error).not.toContain('ENDPOINT');
  expect(result.selectionRequired).not.toBe(true);
 }
 for(const name of ['start_workroom_session','open_code_app'])for(const surface of [undefined,name==='start_workroom_session'?'internal':'app']){
  const result=await call(name,{portId:'project-id',agent:'claude',...(name==='start_workroom_session'?{requestId:'unknown-option-123'}:{}),...(surface?{surface}:{}),model:'PRIVATE_MODEL'});
  expect(result).toMatchObject({success:false,performed:false});
  expect(result.error).toContain('지원하지 않는 필드');
  expect(JSON.stringify(result)).not.toContain('PRIVATE_MODEL');
  expect(result.selectionRequired).not.toBe(true);
 }
 for(const args of [
  {portId:'project-id',requestId:'unknown-team-123',title:'Team',goal:'Goal',unknown:true},
  {portId:'project-id',requestId:'unknown-team-123',title:'Team',goal:'Goal',members:[{agent:'claude',task:'one',unknown:true}]},
 ]){
  const result=await call('create_team',args);
  expect(result).toMatchObject({success:false,performed:false});
  expect(result.error).toContain('지원하지 않는 필드');
  expect(result.selectionRequired).not.toBe(true);
 }
});

test('create_team rejects unsupported member combinations locally before a host request or another member question',async()=>{
 const environment={...env,AGENTSTOZ_USE_ENDPOINT:'http://127.0.0.1:9/api/agentstoz-use/action'};
 const base={portId:'project-id',requestId:'strict-members-123',title:'Team',goal:'Preserve explicit choices'};
 const cases=[
  {member:{agent:'hermes',surface:'internal',provider:'anthropic'},error:'provider는 model과 함께'},
  {member:{agent:'hermes',surface:'iterm',model:'claude-sonnet-4-5',provider:'anthropic'},error:'에서는 모델을 고르지 않습니다'},
  {member:{agent:'codex',surface:'internal',model:'gpt-5',provider:'openai'},error:'provider는 Hermes에서만'},
  {member:{agent:'claude',surface:'internal',launchOptions:{model:'opus'}},error:'알 수 없는 실행 옵션: model'},
 ];
 const host=spyOn(globalThis,'fetch').mockResolvedValue(Response.json({success:true,performed:true,source:'synthetic-host'}));
 try{
  for(const {member,error} of cases)for(const members of [[member],[{agent:'claude'},member]]){
   const args={...base,members},before=JSON.stringify(args);
   const result=await call('create_team',args,environment);
   expect(result).toMatchObject({success:false,performed:false});
   expect(result.error).toContain(error);
   expect(result.error).toContain(`팀원 ${members.length}:`);
   expect(result.selectionRequired).not.toBe(true);
   expect(host).not.toHaveBeenCalled();
   expect(JSON.stringify(args)).toBe(before);
   expect(()=>agentsToZUseMcpActionForTool('agentstoz_use_create_team',args,'controller-id')).toThrow(error);
  }
 }finally{host.mockRestore();}
});

test('an explicit internal Hermes model without a provider reaches the host unchanged and needs no variant answer',async()=>{
 const environment={...env,AGENTSTOZ_USE_ENDPOINT:'http://127.0.0.1:9/api/agentstoz-use/action'};
 const member=Object.freeze({agent:'hermes',surface:'internal',model:'claude-sonnet-4-5',task:'Keep this exact model'});
 const args={portId:'project-id',requestId:'model-only-123',title:'Team',goal:'Use the selected model',members:[member]};
 const sent:unknown[]=[];
 const host=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(_url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  sent.push(JSON.parse(String(init?.body)));
  return Response.json({success:true,performed:true,source:'synthetic-host'});
 },{preconnect:globalThis.fetch.preconnect}));
 try{
  expect(parseTeamMemberSelection(member)).toMatchObject({agent:'hermes',model:member.model});
  expect(agentstozMcpAgentChoice('agentstoz_use_create_team',args)).toBeNull();
  expect(await call('create_team',args,environment)).toMatchObject({success:true,performed:true,source:'synthetic-host'});
  expect(host).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([{action:'workroom-team',controllerPortId:'controller-id',team:{...args,op:'create'}}]);
  expect(member).toEqual({agent:'hermes',surface:'internal',model:'claude-sonnet-4-5',task:'Keep this exact model'});
 }finally{host.mockRestore();}
});
