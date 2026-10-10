import {describe, expect, test} from 'bun:test';
import {Terminal as HeadlessTerminal} from '@xterm/headless';
import {
  defaultWorkroomRouteAgent,
  planWorkroomRoute,
  reconcileRegisteredWorkroomTargets,
  remoteProjectMentionClipboard,
  selectWorkroomMention,
  suggestedWorkroomTargets,
  workroomDeliveryInstruction,
  workroomMentionCandidates,
  workroomMentionQuery,
  workroomRouteConfirmation,
  workroomRouteHeldReceipt,
  workroomRoutePreview,
  workroomRouteReceipt,
} from '../src/workroomProjectMention';
import {readWorkroomScreen, renderWorkroomScreenLines, workroomScreenAwaitsAnswer, workroomScreenExcerpt} from '../src/workroomRouteDelivery';
import {workroomSessionLabels} from '../src/workroomSessionLabel';

const projects=[
  {targetId:'ops',label:'AgentsToZ-Control'},
  {targetId:'alpha',label:'한글 프로젝트'},
  {targetId:'beta',label:'Beta'},
];

describe('workroom project mentions',()=>{
  test('opens at mention and filters normalized Korean labels',()=>{
    expect(workroomMentionQuery('점검 @한글')).toEqual({start:3,query:'한글',kind:'route'});
    expect(workroomMentionCandidates('점검 @프로',projects).map(p=>p.targetId)).toEqual(['alpha']);
  });
  test('selection removes the UI trigger and binds the opaque target',()=>{
    expect(selectWorkroomMention('@한',2,projects[1]!)).toEqual({value:'',cursor:0,target:projects[1]!,kind:'route'});
  });
  test('# opens a reference mention that stays in the text, @ stays a route (VOC 2026-09-24)',()=>{
    expect(workroomMentionQuery('참고 #한글')).toEqual({start:3,query:'한글',kind:'reference'});
    expect(workroomMentionCandidates('참고 #Be',projects).map(p=>p.targetId)).toEqual(['beta']);
    expect(selectWorkroomMention('참고 #Be',6,projects[2]!)).toEqual({value:'참고 #Beta ',cursor:9,target:projects[2]!,kind:'reference'});
    expect(selectWorkroomMention('@한',2,projects[1]!).kind).toBe('route');
    // Several references can be chained in one message.
    expect(workroomMentionQuery('#Beta #한글 프로젝트를 참고해 #A')).toEqual({start:20,query:'A',kind:'reference'});
  });
  test('a # reference is never read as a delivery target',()=>{
    expect(suggestedWorkroomTargets('#Beta 참고해서 새 페이지 만들어',projects)).toEqual([]);
    expect(suggestedWorkroomTargets('#Beta 참고해서 한글 프로젝트에 전달',projects,'',['beta']).map(p=>p.targetId)).toEqual(['alpha']);
  });
  test('natural-language labels are suggestions and never an automatic route',()=>{
    expect(suggestedWorkroomTargets('Beta 프로젝트에 테스트를 전달해',projects).map(p=>p.targetId)).toEqual(['beta']);
    expect(suggestedWorkroomTargets('Beta 프로젝트에 테스트를 전달해',projects,'beta')).toEqual([]);
  });
  test('builds a bounded visible handoff and remote clipboard identity',()=>{
    expect(workroomDeliveryInstruction({task:'테스트 실행',sourceLabel:'OPS',targetLabel:'Beta'})).toContain('보낸 프로젝트: OPS');
    expect(remoteProjectMentionClipboard('Beta','abcdefgh123456')).toBe('#Beta [원격프로젝트해시: ABCDEFGH]');
  });
  test('adds a runtime worktree of a registered project so its Workroom session stays visible',()=>{
    const out=reconcileRegisteredWorkroomTargets(projects,[
      {targetId:'rwt_linked',label:'한글 프로젝트 · feat',scope:'worktree',projectTargetId:'alpha',branch:'feat'},
      {targetId:'rwt_orphan',label:'남의 워크트리',scope:'worktree',projectTargetId:'not-registered'},
    ]);
    expect(out.map(p=>p.targetId)).toEqual(['ops','alpha','beta','rwt_linked']);
  });
  test('the handoff names the sending AI when it is known, so a different AI knows who asked',()=>{
    expect(workroomDeliveryInstruction({task:' 테스트 실행 ',sourceLabel:'OPS',sourceAgentLabel:'Antigravity',targetLabel:'Beta'}))
      .toBe('AgentsToZ 프로젝트 전달\n보낸 프로젝트: OPS\n보낸 AI: Antigravity\n받는 프로젝트: Beta\n\n테스트 실행');
    expect(workroomDeliveryInstruction({task:'x',sourceLabel:'A',targetLabel:'B'})).toBe('AgentsToZ 프로젝트 전달\n보낸 프로젝트: A\n받는 프로젝트: B\n\nx');
  });
  test('keeps the Project/Folder inventory authoritative during partial runtime discovery',()=>{
    expect(reconcileRegisteredWorkroomTargets(projects,[
      {targetId:'alpha',label:'old runtime label',scope:'main'},
      {targetId:'detached',label:'runtime only',scope:'worktree'},
    ])).toEqual([
      {targetId:'ops',label:'AgentsToZ-Control'},
      {targetId:'alpha',label:'한글 프로젝트',scope:'main'},
      {targetId:'beta',label:'Beta'},
    ]);
  });
});

// `@` routing is not limited to the sender's AI (2026-09-29): an OPS Workroom opened with
// Antigravity can hand work to a Claude or Codex Workroom of another project.
describe('workroom routing across AIs',()=>{
  const session=(id:string,targetId:string,agent:'codex'|'claude'|'hermes'|'agy',state:'running'|'exited'='running',createdAt='2026-09-29T00:00:00Z')=>({id,targetId,agent,state,createdAt});
  const current=session('ops-agy','ops','agy');
  const sessions=[
    current,
    session('beta-codex','beta','codex','running','2026-09-29T00:10:00Z'),
    session('beta-claude-old','beta','claude','running','2026-09-28T09:00:00Z'),
    session('beta-claude-new','beta','claude','running','2026-09-29T03:00:00Z'),
    session('beta-hermes-ended','beta','hermes','exited','2026-09-29T05:00:00Z'),
  ];
  test('suggests the AI already running in the target, else the current AI',()=>{
    expect(defaultWorkroomRouteAgent(sessions,current,'beta','codex')).toBe('claude');
    expect(defaultWorkroomRouteAgent(sessions,current,'alpha','codex')).toBe('agy');
    // The current session is itself the running session of its own project.
    expect(defaultWorkroomRouteAgent([...sessions,session('ops-codex','ops','codex','running','2026-09-29T09:00:00Z')],current,'ops','codex')).toBe('agy');
    expect(defaultWorkroomRouteAgent([],null,'beta','hermes')).toBe('hermes');
  });
  test('delivers to the newest running session of the chosen AI and starts one only when none runs',()=>{
    expect(planWorkroomRoute(sessions,current,'beta','claude')).toEqual({kind:'deliver',session:sessions[3]!});
    expect(planWorkroomRoute(sessions,current,'beta','codex')).toEqual({kind:'deliver',session:sessions[1]!});
    // An ended session never receives input.
    expect(planWorkroomRoute(sessions,current,'beta','hermes')).toEqual({kind:'start'});
    expect(planWorkroomRoute(sessions,current,'beta','agy')).toEqual({kind:'start'});
    expect(planWorkroomRoute(sessions,current,'ops','agy')).toEqual({kind:'current'});
    // The same project with another AI is a real handoff, not the current conversation.
    expect(planWorkroomRoute(sessions,current,'ops','claude')).toEqual({kind:'start'});
    expect(planWorkroomRoute(sessions,null,'beta','codex')).toEqual({kind:'deliver',session:sessions[1]!});
  });
  // Updated 2026-09-29 (review M2): delivering types into a live session the user is not looking at,
  // so the deliver dialog now always says that Enter is pressed there. The first line is unchanged.
  test('the confirmation and preview say which session receives the message',()=>{
    expect(workroomRouteConfirmation('deliver','Beta','Claude Code')).toBe('‘Beta’ 프로젝트에서 실행 중인 Claude Code 워크룸 세션으로 이 메시지를 전달할까요?\n실행 중인 세션에 이 메시지를 입력하고 Enter를 누릅니다.');
    expect(workroomRouteConfirmation('start','Beta','Claude Code')).toBe('‘Beta’ 프로젝트에 Claude Code 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?');
    expect(workroomRoutePreview('current','OPS','Antigravity')).toBe('현재 세션에 그대로 보냅니다.');
    expect(workroomRoutePreview('deliver','Beta','Claude Code')).toBe('‘Beta’에서 실행 중인 Claude Code 세션에 전달합니다.');
    expect(workroomRoutePreview('start','Beta','Hermes')).toBe('‘Beta’에 새 Hermes 세션을 열고 첫 요청으로 전달합니다.');
  });
  test('M2/L4: the deliver dialog names the receiving session and shows its last lines, or says it could not',()=>{
    const shown=workroomRouteConfirmation('deliver','Beta','Claude Code',{sessionLabel:'Beta · claude #2',screen:['⏺ 테스트 12개 통과','? for shortcuts']});
    expect(shown.split('\n')).toEqual(['‘Beta’ 프로젝트에서 실행 중인 Claude Code 워크룸 세션으로 이 메시지를 전달할까요?','받는 세션: Beta · claude #2',
      '실행 중인 세션에 이 메시지를 입력하고 Enter를 누릅니다.','','그 세션 화면의 마지막 줄:','│ ⏺ 테스트 12개 통과','│ ? for shortcuts']);
    const unknown=workroomRouteConfirmation('deliver','Beta','Claude Code',{screen:null});
    expect(unknown).toContain('그 세션 화면을 확인하지 못했습니다');expect(unknown).toContain('Enter를 누릅니다');
  });
  test('M2: a session waiting on a question is not typed into; the dialog offers a new session or keeps the draft',()=>{
    const blocked=workroomRouteConfirmation('blocked','Beta','Claude Code',{sessionLabel:'Beta · claude',screen:['Do you trust the files in this folder?','❯ 1. Yes, proceed','2. No, exit']});
    expect(blocked).toContain('질문이나 승인에 대한 답을 기다리는 화면입니다');
    expect(blocked).toContain('그 세션에는 입력하지 않습니다');
    expect(blocked).toContain('│ ❯ 1. Yes, proceed');
    expect(blocked).toContain('대신 ‘Beta’ 프로젝트에 Claude Code 워크룸 세션을 새로 열고 이 메시지를 첫 요청으로 전달할까요?');
    expect(blocked.endsWith('취소하면 작성 중인 내용을 그대로 둡니다.')).toBe(true);
    expect(workroomRouteConfirmation('blocked','Beta','Codex CLI',{typed:true})).toContain('대신 ‘Beta’ 프로젝트에 Codex CLI 워크룸 세션을 새로 열고, 준비되면 이 메시지를 입력할까요?');
  });
  test('M1: a start that cannot carry the message says it will be typed once the session is ready',()=>{
    const typed=workroomRouteConfirmation('start','Beta','Codex CLI',{typed:true});
    expect(typed).toContain('새로 열고, 준비되면 이 메시지를 입력할까요?');
    expect(typed).toContain('그 화면이 질문(폴더 신뢰·승인 등)을 띄우면 입력하지 않습니다');
    expect(workroomRoutePreview('start','Beta','Codex CLI',{typed:true})).toContain('준비되면 메시지를 입력합니다');
    expect(workroomRoutePreview('deliver','Beta','Claude Code',{sessionLabel:'Beta · claude #2'})).toBe('‘Beta’에서 실행 중인 Claude Code 세션에 전달합니다. (받는 세션: Beta · claude #2)');
  });
  test('the receipt names the session that received the message',()=>{
    expect(workroomRouteReceipt({started:false,targetLabel:'Beta',agentName:'Claude Code'})).toBe('‘Beta’의 Claude Code 세션에 전달했습니다.');
    expect(workroomRouteReceipt({started:true,targetLabel:'Beta',agentName:'Antigravity'}))
      .toBe('‘Beta’에 새 Antigravity 세션을 열고 첫 요청으로 전달했습니다. 처음 여는 폴더라면 그 세션에서 폴더 신뢰 확인이 먼저 나올 수 있습니다.');
    expect(workroomRouteReceipt({started:true,targetLabel:'Beta',agentName:'Codex CLI',referencesDropped:true}))
      .toContain('이 Mac 버전은 새 세션에 # 참고 폴더를 함께 넘기지 못해 프로젝트 이름만 전달했습니다.');
    // L4: with several sessions of that AI, the receipt says which one (the tab label with #n).
    expect(workroomRouteReceipt({started:false,targetLabel:'Beta',agentName:'Claude Code',sessionLabel:'Beta · claude #2'})).toBe('‘Beta’의 Claude Code 세션에 전달했습니다. 받는 세션: Beta · claude #2');
    expect(workroomRouteReceipt({started:true,typed:'size',targetLabel:'Beta',agentName:'Codex CLI'})).toBe('‘Beta’에 새 Codex CLI 세션을 열고, 화면이 준비된 뒤 메시지를 입력했습니다. 메시지가 길어 첫 요청에 담지 못했습니다.');
    expect(workroomRouteReceipt({started:true,typed:'host',targetLabel:'Beta',agentName:'Hermes'})).toContain('이 Mac 버전은 새 세션의 첫 요청으로 받지 못했습니다.');
  });
  test('a new session that was not typed into keeps the draft and says what to do',()=>{
    expect(workroomRouteHeldReceipt({targetLabel:'Beta',agentName:'Claude Code',reason:'awaiting',screen:['Do you trust the files in this folder?','❯ 1. Yes, proceed','2. No, exit']}))
      .toBe('‘Beta’에 새 Claude Code 세션을 열었지만, 그 세션이 질문이나 승인에 대한 답을 기다리고 있어 메시지를 입력하지 않았습니다. 그 세션에서 답한 뒤 다시 전달하세요. 마지막 줄: Do you trust the files in this folder? / ❯ 1. Yes, proceed / 2. No, exit 작성 중인 내용은 유지했습니다.');
    expect(workroomRouteHeldReceipt({targetLabel:'Beta',agentName:'Codex CLI',reason:'timeout'})).toContain('화면이 준비되지 않아 메시지를 입력하지 않았습니다');
    expect(workroomRouteHeldReceipt({targetLabel:'Beta',agentName:'Codex CLI',reason:'exited'})).toContain('곧바로 종료되어');
  });
  test('the functions the LAN page embeds run on their own',()=>{
    // remoteControlMobilePage embeds these with toString(); a module-scope reference would break the phone page.
    const load=(fn:Function)=>new Function(`"use strict";return (${fn.toString()});`)();
    expect(load(planWorkroomRoute)(sessions,current,'beta','claude')).toEqual({kind:'deliver',session:sessions[3]});
    expect(load(defaultWorkroomRouteAgent)(sessions,current,'beta','codex')).toBe('claude');
    expect(load(workroomRouteConfirmation)('start','Beta','Codex CLI')).toContain('새로 열고');
    expect(load(workroomRouteConfirmation)('blocked','Beta','Codex CLI',{sessionLabel:'Beta · codex',screen:['[y/N]']})).toContain('│ [y/N]');
    expect(load(workroomDeliveryInstruction)({task:'t',sourceLabel:'A',sourceAgentLabel:'Hermes',targetLabel:'B'})).toContain('보낸 AI: Hermes');
    expect(load(workroomSessionLabels)(sessions,(id:string)=>id).get('beta-claude-new')).toBe('beta · claude #2');
  });
  test('the screen helpers the LAN page embeds run on their own',async()=>{
    const load=(fn:Function)=>new Function(`"use strict";return (${fn.toString()});`)();
    expect(load(workroomScreenAwaitsAnswer)(['Do you want to proceed?','❯ 1. Yes','2. No'])).toBe(true);
    expect(load(workroomScreenAwaitsAnswer)(['> ','? for shortcuts'])).toBe(false);
    expect(load(workroomScreenExcerpt)(['│ a │','','b'])).toEqual(['a','b']);
    const lines=await load(renderWorkroomScreenLines)((cols:number,rows:number)=>new HeadlessTerminal({cols,rows,allowProposedApi:true}),'one\r\ntwo',20,5);
    expect(lines).toEqual(['one','two','','','']);
    expect(await load(readWorkroomScreen)({sessionId:'s-12345678',read:async()=>({chunks:[{seq:1,text:'x'}],hasMore:false}),render:async(text:string)=>[text]})).toEqual({lines:['x'],complete:true});
  });
});
