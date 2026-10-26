import {expect,test} from 'bun:test';
import {readTeamBuilderDraft,teamLeaderInstruction} from '../src/workroomTeamInstruction';
import {blankTeamRow,restoredTeamRows,teamRowMember} from '../src/WorkroomTeamBuilder';
import {parseTeamSelectionBlock,teamSelectionBlock} from '../src/teamLaunchOptions';
import {hermesVariantItems} from '../src/hermesVariants';

const variants=hermesVariantItems(new Set(['anthropic']));
test('reopening the composed draft restores only its goal and exact member choices, then a bypass cancellation replaces old authority',()=>{
 const old=teamLeaderInstruction({goal:'결제 오류 수정',members:[{agent:'codex',name:'api',model:'future-model',effort:'high',bypassPermissions:true,task:'API'},
  {agent:'hermes',model:'claude-opus-5-5',provider:'anthropic',role:'reviewer',task:'검토'},
  {agent:'agy',surface:'iterm',launchOptions:{tmuxMode:false,reuse:'new'}}]});
 const draft=readTeamBuilderDraft(old);
 expect(draft.goal).toBe('결제 오류 수정');
 expect(draft.members).toEqual(parseTeamSelectionBlock(old).members);
 const rows=restoredTeamRows(draft.members!);
 expect(rows[0]).toMatchObject({name:'api',custom:true,model:'future-model',effort:'high',bypass:true,task:'API'});
 expect(rows[2]).toMatchObject({surface:'iterm',options:{tmuxMode:false,reuse:'new'}});
 rows[0]!.bypass=false;
 const members=rows.map(row=>{const result=teamRowMember(row,{variants});expect(result.problem).toBeUndefined();return result.member!;});
 const next=teamLeaderInstruction({goal:draft.goal,members});
 expect((next.match(/```agentstoz-team-selection/g)??[]).length).toBe(1);
 expect(parseTeamSelectionBlock(next).members[0]).toEqual({agent:'codex',name:'api',model:'future-model',effort:'high',task:'API'});
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
