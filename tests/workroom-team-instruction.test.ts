import {expect,test} from 'bun:test';
import {readTeamBuilderDraft,teamLeaderInstruction} from '../src/workroomTeamInstruction';
import {blankTeamRow,restoredTeamRows,teamRowMember} from '../src/WorkroomTeamBuilder';
import {parseTeamSelectionBlock,teamSelectionBlock} from '../src/teamLaunchOptions';
import {hermesVariantItems} from '../src/hermesVariants';
import {AGENTSTOZ_TEAM_SKILL} from '../src/agentstozTeamSkill';

const variants=hermesVariantItems(new Set(['anthropic']));
test('reopening the composed draft restores only its goal and exact member choices, then a bypass cancellation replaces old authority',()=>{
 // gpt-reserve: a Codex catalog model that is not a builder preset, so it restores as 직접 입력 and its pinned level stays valid.
 const old=teamLeaderInstruction({goal:'결제 오류 수정',members:[{agent:'codex',name:'api',model:'gpt-reserve',effort:'high',bypassPermissions:true,task:'API'},
  {agent:'hermes',model:'claude-opus-5-5',provider:'anthropic',role:'reviewer',task:'검토'},
  {agent:'agy',surface:'iterm',launchOptions:{tmuxMode:false,reuse:'new'}}]});
 const draft=readTeamBuilderDraft(old);
 expect(draft.goal).toBe('결제 오류 수정');
 expect(draft.members).toEqual(parseTeamSelectionBlock(old).members);
 const rows=restoredTeamRows(draft.members!);
 expect(rows[0]).toMatchObject({name:'api',custom:true,model:'gpt-reserve',effort:'high',bypass:true,task:'API'});
 expect(rows[2]).toMatchObject({surface:'iterm',options:{tmuxMode:false,reuse:'new'}});
 rows[0]!.bypass=false;
 const members=rows.map(row=>{const result=teamRowMember(row,{variants});expect(result.problem).toBeUndefined();return result.member!;});
 const next=teamLeaderInstruction({goal:draft.goal,members});
 expect((next.match(/```agentstoz-team-selection/g)??[]).length).toBe(1);
 expect(parseTeamSelectionBlock(next).members[0]).toEqual({agent:'codex',name:'api',model:'gpt-reserve',effort:'high',task:'API'});
 expect(next).not.toContain('bypassPermissions');
 expect(readTeamBuilderDraft(next).goal).toBe('결제 오류 수정');
});
test('legacy canonical defaults restore, while duplicate, malformed and ambiguous raw drafts cannot become new goals',()=>{
 const text=teamLeaderInstruction({goal:'원래 목표',members:[{agent:'hermes'}]});
 const legacy=text.replace(/```agentstoz-team-selection\n[\s\S]*?\n```/, '```agentstoz-team-selection\n{"kind":"agentstoz-team-selection","version":1,"members":[{"agent":"hermes"}]}\n```');
 expect(restoredTeamRows(readTeamBuilderDraft(legacy).members!)[0]).toMatchObject({agent:'hermes',surface:'internal',model:'',provider:'',variant:''});
 expect(readTeamBuilderDraft('새 목표')).toEqual({goal:'새 목표'});
 expect(()=>readTeamBuilderDraft(text+'\n'+teamSelectionBlock([{agent:'codex'}]))).toThrow('팀 선택 블록이 둘');
 expect(()=>readTeamBuilderDraft('```agentstoz-team-selection\n{broken}\n```')).toThrow('JSON');
 expect(()=>readTeamBuilderDraft(teamSelectionBlock([{agent:'codex'}]))).toThrow('목표를 확인하지 못했습니다');
 expect(()=>teamLeaderInstruction({goal:text,members:[{agent:'codex'}]})).toThrow('팀 선택 블록이 둘');
 expect(()=>teamLeaderInstruction({goal:'새 목표',members:[{agent:'codex',task:text}]})).toThrow('팀 선택 블록이 둘');
});
test('external members use the selected surface and member operations, never a Workroom-only instruction path',()=>{
 const text=teamLeaderInstruction({goal:'화면 검사',members:[{agent:'claude',surface:'cmux',launchOptions:{bgMode:false,tmuxMode:false,reuse:'new'}}]});
 expect(text).toContain('각자의 워크트리와 고른 실행 위치');
 expect(text).toContain('agentstoz_use_team_member의 read/send/reveal');
 expect(text).toContain('수동 확인·옮긴 보고');
 expect(text).not.toContain('각자의 워크트리 워크룸');
 expect(text).not.toContain('agentstoz_use_send_workroom_instruction');
});
test('plain Hermes presets enforce the same known provider availability as variants, and a missing attached session never becomes fresh',()=>{
 const plain={...blankTeamRow(0,'hermes'),model:'gpt-6.1-sol',provider:'openai-codex'};
 expect(teamRowMember(plain,{variants})).toEqual({problem:'variant-missing'});
 expect(teamRowMember({...plain,custom:true},{variants})).toEqual({problem:'variant-missing'});
 expect(teamRowMember({...plain,model:'claude-opus-5-5',provider:'anthropic'},{variants}).problem).toBeUndefined();
 expect(teamRowMember({...blankTeamRow(1,'codex'),sessionId:'session-ended'},{variants})).toEqual({problem:'session-missing'});
});
test('the app member computer use opt-in is the builder\'s own choice: off by default, carried in the block, refused off an app',()=>{
 expect(blankTeamRow(0,'codex').computerUse).toBeUndefined();
 const plain=teamLeaderInstruction({goal:'앱 작업',members:[{agent:'codex',surface:'app',task:'앱에서 구현'}]});
 expect(plain).not.toContain('computerUseApprovals');expect(plain).not.toContain('컴퓨터 유즈');
 const row={...blankTeamRow(0,'codex'),surface:'app' as const,task:'앱에서 구현',computerUse:true};
 const member=teamRowMember(row,{variants}).member!;
 expect(member).toMatchObject({surface:'app',computerUseApprovals:true});
 const text=teamLeaderInstruction({goal:'앱 작업',members:[member,{agent:'claude',task:'워크룸 작업'}]});
 expect(parseTeamSelectionBlock(text).members[0]).toMatchObject({agent:'codex',surface:'app',computerUseApprovals:true});
 expect(parseTeamSelectionBlock(text).members[1]).not.toHaveProperty('computerUseApprovals');
 expect(text).toContain('리더가 1회성 승인만 컴퓨터 유즈로 응답 가능');
 expect(text).toContain('항상 허용·다시 묻지 않기·권한 우회·네트워크/전체 접근·로그인·macOS 시스템 창·AgentsToZ/Control 승인은 사람에게');
 expect(text).toContain('read/send/reveal/keys');
 expect(restoredTeamRows(readTeamBuilderDraft(text).members!)[0]).toMatchObject({surface:'app',computerUse:true});
 // Moving the member off the app keeps the tick visible and lets the shared parser refuse it, never drop it.
 expect(()=>teamLeaderInstruction({goal:'앱 작업',members:[teamRowMember({...row,surface:'orca-worktree'},{variants}).member!]})).toThrow('데스크톱 앱');
});
test('a requested remote computer-use team names the device and coordinates unknown inputs without changing chosen members',()=>{
 const members=[{agent:'codex' as const,task:'화면 확인'},{agent:'claude' as const,role:'reviewer' as const}];
 const local=teamLeaderInstruction({goal:'화면 검사',members});
 const remote=teamLeaderInstruction({goal:'다른 Mac에서 컴퓨터 유즈로 화면 확인',members});
 expect(parseTeamSelectionBlock(remote)).toEqual(parseTeamSelectionBlock(local));
 expect(readTeamBuilderDraft(remote).goal).toBe('다른 Mac에서 컴퓨터 유즈로 화면 확인');
 expect(remote).toContain('devices로 대상을 확인');
 expect(remote).toContain('대상이 불분명하면 임의로 고르지 않습니다');
 expect(remote).toContain('한 번에 한 팀원에게만');
 expect(remote).toContain('원래 연결에서 같은 device와 requestId로 receipt');
 expect(remote).toContain('다른 팀원·새 연결·새 requestId로 입력을 반복하지 않습니다');
 expect(remote).toContain('원격 Mac 승인이나 전체 Mac 권한을 추가하지 않습니다');
 expect(local).not.toContain('devices로 대상을 확인');
 expect(AGENTSTOZ_TEAM_SKILL).toContain('not a device-wide lock');
 expect(AGENTSTOZ_TEAM_SKILL).toContain('original MCP connection');
 expect(AGENTSTOZ_TEAM_SKILL).toContain('never repeat the input through another member');
});
test('remote computer-use guidance also follows an explicitly assigned English member task',()=>{
 const text=teamLeaderInstruction({goal:'Improve the workflow',members:[{agent:'codex',task:'Use remote computer-use on the named Mac'}]});
 expect(text).toContain('devices로 대상을 확인');
 expect(parseTeamSelectionBlock(text).members[0]).toMatchObject({agent:'codex',task:'Use remote computer-use on the named Mac'});
});
