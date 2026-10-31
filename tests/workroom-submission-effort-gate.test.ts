/**
 * 「현재 세션에 전송」 stopped working (2026-10-30, installed 1577): Claude from its second request, Codex from its first.
 * The installed history showed both stuck at `prepared` — refused before the write fence — and a live Claude 2.1.314
 * Workroom reproduced it: after a turn Claude draws its next-prompt suggestion dimmed in the composer, 「에포트 자동」
 * read that as a busy composer and waited 60 s before every write, past every client timeout (browser 15 s, app proxy
 * and MCP 20 s) and the 30 s submission lifetime. The request was never typed and its `prepared` receipt fenced the
 * composer for good. Codex's hooks review screen refused the same way, at once.
 *
 * Real service, real WorkroomSubmissions and the real native effort control, fake PTY only — no CLI or model is
 * started. The fixture has no activity sampler, so the session never proves itself idle unless a test says so through
 * the control's own `idle` input (the one fact a fake PTY cannot produce).
 */
import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AiTerminalService} from '../src/aiTerminalService';
import {WorkroomConversationJournal} from '../src/workroomConversationJournal';
import {createWorkroomEffortSetting} from '../src/workroomEffortSetting';
import {submitWorkroomDraft} from '../src/workroomSubmissionClient';
import {changeWorkroomEffort} from '../src/workroomEffortRuntime';
import {workroomEffortAdviceText,workroomEffortBadgeText} from '../src/workroomEffortView';

const cleanup:(()=>Promise<unknown>)[]=[];afterEach(async()=>{for(const c of cleanup.splice(0).reverse())await c();});
const rule='─'.repeat(70);
/** Observed Claude Code 2.1.314 after a turn: the suggestion is dimmed after the cursor at Home; the effort row may be gone. */
const claudeSuggestion=(effortLine='')=>`\x1b[2J\x1b[H ▐▛███▛█   Claude Code v2.1.314\r\n${effortLine}\r\n${rule}\r\n❯ \x1b[2mWR-SEND-DIAG-C3 마커 한 줄과 현재 브랜치명만 출력하세요.\x1b[22m\r\n${rule}\r\n  ⏸ manual mode on\x1b[4;3H`;
/** Observed on the 2.1.314 start screen, right-aligned above the composer. */
const claudeEffortRow='                                        ◉ xhigh · /effort';
/** Codex 0.166.0 in this repository: the hooks review dialog comes first. */
const codexHooks='\x1b[2J\x1b[H  Hooks need review\r\n  4 hooks are new or changed.\r\n\r\n› 1. Review hooks\r\n  2. Trust all and continue\r\n  3. Continue without trusting (hooks won\'t run)\r\n\r\n  enter confirm · esc skip\x1b[4;2H';
/** Codex at rest with its model-and-reasoning footer. */
const codexIdle='\x1b[2J\x1b[H• Done.\r\n\r\n› Ask Codex to do anything\r\n\r\n  gpt-6.1-sol high · 100% context left\x1b[3;3H';
/** Claude's session-only picker: `/effort`⏎ opens it, ←/→ move, `s` keeps the level for this session and closes it. */
function claudePicker(start:string){
 const levels=['low','medium','high','xhigh'];let level=start;
 return (text:string,emit:(screen:string)=>void)=>{
  if(text==='/effort\r')emit('\x1b[2J\x1b[H'+'   Effort\r\n\r\n         Faster                             Smarter\r\n         ──────────────────────────────▲───────────\r\n         low     medium     high     xhigh      max\r\n\r\n   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel');
  else if(text==='\x1b[D'||text==='\x1b[C')level=levels[levels.indexOf(level)+(text==='\x1b[D'?-1:1)]!;
  else if(text==='s')emit(claudeSuggestion(`  ⎿ Set effort level to ${level} (this session only)`));
 };
}
type Respond=(text:string,emit:(screen:string)=>void)=>void;
function fixture(agent:'claude'|'codex',screen:string,options:{respond?:Respond;idle?:()=>boolean;switchable?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'submission-effort-gate-')),store=new WorkroomConversationJournal(root),setting=createWorkroomEffortSetting(root);
 const writes:string[]=[];let emit:(screen:string)=>void=()=>{};
 const service=new AiTerminalService({submissions:()=>store,effortAuto:setting,resolveTarget:async()=>({cwd:root}),executable:()=>'/fixture/'+agent,activitySampler:false,
  codexEffortModel:()=>({ok:true,model:'gpt-6.1-sol',allowed:['low','medium','high']}),
  effortRuntimeSupport:()=>({claudeSessionPicker:agent==='claude'&&options.switchable!==false,codexDefaultKeys:agent==='codex'&&options.switchable!==false}),
  ...(options.idle?{effortRuntime:control=>changeWorkroomEffort({...control,idle:options.idle!})}:{}),
  spawn:(_args,o:any)=>{let exit!:(n:number)=>void;const exited=new Promise<number>(r=>{exit=r;});
   emit=text=>o.terminal.data(null,new TextEncoder().encode(text));
   queueMicrotask(()=>emit(screen));
   return {pid:710001,exited,kill:()=>exit(143),terminal:{write:(text:string)=>{writes.push(text);options.respond?.(text,emit);return Buffer.byteLength(text);},resize(){},close(){}}} as any;}});
 cleanup.push(async()=>{await service.shutdown();store.close();rmSync(root,{recursive:true,force:true});});
 const start=async()=>{const r=await service.perform({operation:'start',requestId:crypto.randomUUID(),targetId:'project-gate-0001',agent,cols:100,rows:28});await Bun.sleep(20);return r.session!;};
 const send=(sessionId:string,text:string,id:string)=>submitWorkroomDraft({id,sessionId,text:text+'\r',prepared:()=>{},request:r=>service.perform({...r,requestId:crypto.randomUUID()})});
 const status=async(sessionId:string,id:string)=>(await service.perform({operation:'submission',requestId:crypto.randomUUID(),sessionId,submission:{phase:'status',id}})).submission!.state;
 const effort=(s:{id:string;targetId:string})=>service.workspaceEffort({targetId:s.targetId,sessionId:s.id,effortModes:true}).session!;
 return {service,writes,start,send,status,effort,emit:(text:string)=>emit(text)};
}
/** Settles within `ms`, or says it did not (the old gate held every write for 60 s). */
const within=<T>(ms:number,work:Promise<T>)=>Promise.race([work.then(value=>({value}),error=>({error:error as Error})),Bun.sleep(ms).then(()=>({late:true as const}))]);

test('a dimmed Claude suggestion with an effort the CLI does not show: the request is written at once, no effort keys, and the advice says it was not adjusted',async()=>{
 const f=fixture('claude',claudeSuggestion()),s=await f.start();
 const result=await within(2_500,f.send(s.id,'git 상태만 알려줘','gate-claude-unreadable-0001'));
 expect(result).toEqual({value:expect.objectContaining({state:'written'})});
 // Only the request and its Enter: no /effort picker, no Escape.
 expect(f.writes.join('')).toBe('git 상태만 알려줘\r');
 const view=f.effort(s);
 expect(view.advice?.tier).toBe('medium');
 // What the screen shows: Auto did not change it, and this request went as the CLI runs — not 「입력 대기」, not applied.
 expect(workroomEffortBadgeText(view)).toBe('에포트 자동 · 이번 요청은 변경 안 함');
 expect(workroomEffortAdviceText(view)).toBe('에포트는 지금 그대로입니다 · 이번 요청의 권장 보통으로 바꾸지 않았습니다 · 바꾸려면 「에포트 변경」');
});

test('Claude 2.1.314 at rest: 「에포트 자동」 changes the level for this session first, then types the request once',async()=>{
 const f=fixture('claude',claudeSuggestion(claudeEffortRow),{respond:claudePicker('xhigh'),idle:()=>true}),s=await f.start();
 const result=await within(5_000,f.send(s.id,'git 상태만 알려줘','gate-claude-applied-0001'));
 expect(result).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes.slice(0,4)).toEqual(['/effort\r','\x1b[D','\x1b[D','s']);
 expect(f.writes.slice(4).join('')).toBe('git 상태만 알려줘\r');
 const view=f.effort(s);
 expect(view.runtimeStatus).toBe('applied');expect(view.level).toBe('medium');expect(view.advice).toBeUndefined();
});

test('no idle proof within 4 s: the request goes at the current level, said as advice — never 「입력 대기」 — and the next request is judged again',async()=>{
 let idle=false;
 const f=fixture('claude',claudeSuggestion(claudeEffortRow),{respond:claudePicker('xhigh'),idle:()=>idle}),s=await f.start();
 const begun=Date.now();
 const first=await within(9_000,f.send(s.id,'git 상태만 알려줘','gate-claude-busy-0001'));
 expect(first).toEqual({value:expect.objectContaining({state:'written'})});
 expect(Date.now()-begun).toBeLessThan(6_000);
 // Nothing but the request reached the CLI.
 expect(f.writes.join('')).toBe('git 상태만 알려줘\r');
 const view=f.effort(s);
 expect(view.runtimeStatus).toBeUndefined();
 expect(view.seen).toBe('xhigh');
 expect(workroomEffortBadgeText(view)).toBe('에포트 자동 · 이번 요청은 변경 안 함');
 expect(workroomEffortAdviceText(view)).toBe('에포트는 지금 xhigh 그대로입니다 · 이번 요청의 권장 보통으로 바꾸지 않았습니다 · 바꾸려면 「에포트 변경」');
 // The turn ends and the effort row scrolls away: the kept level still lets the next request be adjusted.
 idle=true;f.emit(claudeSuggestion());await Bun.sleep(30);
 const before=f.writes.length;
 expect(await within(5_000,f.send(s.id,'git 상태만 알려줘','gate-claude-busy-0002'))).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes.slice(before,before+4)).toEqual(['/effort\r','\x1b[D','\x1b[D','s']);
 expect(f.effort(s).runtimeStatus).toBe('applied');
},15_000);

for(const [agent,screen,key] of [['claude',claudeSuggestion(claudeEffortRow),'/effort\r'],['codex',codexIdle,'\x1b,']] as const)
 test(`${agent}: an effort key typed but never confirmed refuses the request — nothing of it is typed, and the same id stays refused`,async()=>{
  // The CLI never answers the key: no picker, no new level.
  const f=fixture(agent,screen,{idle:()=>true}),s=await f.start();
  const result=await within(9_000,f.send(s.id,'git 상태만 알려줘',`gate-${agent}-partial-0001`));
  expect('error' in result&&result.error.message).toContain('확인하지 못했습니다');
  expect(f.writes).toEqual([key]);
  expect(await f.status(s.id,`gate-${agent}-partial-0001`)).toBe('rejected');
  expect((await f.send(s.id,'git 상태만 알려줘',`gate-${agent}-partial-0001`)).state).toBe('rejected');
  expect(f.writes).toEqual([key]);
  expect(f.effort(s).runtimeStatus).toBe('unconfirmed');
 },15_000);

test('a question screen still refuses at once, and its receipt says the request never ran instead of fencing the composer',async()=>{
 const f=fixture('codex',codexHooks),s=await f.start();
 const result=await within(2_500,f.send(s.id,'git 상태만 알려줘','gate-codex-question-0001'));
 expect('error' in result&&result.error.message).toContain('승인·선택 화면');
 expect(f.writes).toEqual([]);
 expect(await f.status(s.id,'gate-codex-question-0001')).toBe('rejected');
 // The same id is never written later: a replay answers the same refusal receipt.
 expect((await f.send(s.id,'git 상태만 알려줘','gate-codex-question-0001')).state).toBe('rejected');
 expect(f.writes).toEqual([]);
});

/**
 * Measured 2026-10-31 in Claude 2.1.314 at the Workroom's 105×11: the slider opens but its footer
 * 「←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel」 falls below the screen (it fits from 13 rows).
 * v1594 refused the request and left this slider open; the Codex click QA met it as 「Effort · xhigh」.
 */
const claudeClippedPicker='\x1b[2J\x1b[H   Effort\r\n\r\n                      Faster                             Smarter\r\n                      ──────────────────────────────▲───────────      Ultracode  off\r\n                      low     medium     high     xhigh      max      Tab to toggle\r\n\r\n                             ~2.5x the estimated cost of medium (the default)';
/** Escape on that slider in the same CLI: 「⎿  Cancelled」, the level as it was, an empty composer. */
const claudeCancelled=`\x1b[2J\x1b[H ▐▛███▛█   Claude Code v2.1.314\r\n❯ /effort\r\n  ⎿  Cancelled\r\n${claudeEffortRow}\r\n${rule}\r\n❯ \r\n${rule}\x1b[6;3H`;
test('a Claude slider whose session-only footer is cut off is cancelled with Escape, the request goes at the current level, and the next one types no effort key',async()=>{
 const f=fixture('claude',claudeSuggestion(claudeEffortRow),{idle:()=>true,respond:(text,emit)=>{
  if(text==='/effort\r')emit(claudeClippedPicker);else if(text==='\x1b')emit(claudeCancelled);}}),s=await f.start();
 const first=await within(9_000,f.send(s.id,'git 상태만 알려줘','gate-claude-clipped-0001'));
 expect(first).toEqual({value:expect.objectContaining({state:'written'})});
 // Never Enter or `s` on a slider whose `s` is unproven: only the cancel, then the request once.
 expect(f.writes.slice(0,2)).toEqual(['/effort\r','\x1b']);
 expect(f.writes.slice(2).join('')).toBe('git 상태만 알려줘\r');
 const view=f.effort(s);
 expect(view.runtimeStatus).toBeUndefined();expect(view.level).not.toBe('medium');
 expect(workroomEffortBadgeText(view)).toBe('에포트 자동 · 이번 요청은 변경 안 함');
 expect(workroomEffortAdviceText(view)).toBe('에포트는 지금 xhigh 그대로입니다 · 이번 요청의 권장 보통으로 바꾸지 않았습니다 · 바꾸려면 「에포트 변경」');
 expect(Object.keys(view)).not.toContain('effortRefusal');
 // The screen is as short as before: opening the slider again would only repeat the cancel.
 f.emit(claudeCancelled);await Bun.sleep(30);
 const before=f.writes.length;
 expect(await within(5_000,f.send(s.id,'git 상태만 알려줘','gate-claude-clipped-0002'))).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes.slice(before).join('')).toBe('git 상태만 알려줘\r');
 expect(workroomEffortBadgeText(f.effort(s))).toBe('에포트 자동 · 이번 요청은 변경 안 함');
},20_000);

/** Codex 0.166 with gpt-6.1-sol (Codex click QA, 2026-10-31): the shortcut is refused and the level stays. */
const codexRefused='\x1b[2J\x1b[H• Done.\r\n■ Reasoning shortcuts are unavailable for gpt-6.1-sol.\r\n› Ask Codex to do anything\r\n\r\n  gpt-6.1-sol high · 100% context left\x1b[3;3H';
test('a Codex model that refuses reasoning shortcuts: the request goes at the current level and the shortcut is not pressed again',async()=>{
 const f=fixture('codex',codexIdle,{respond:(text,emit)=>{if(text==='\x1b,')emit(codexRefused);}}),s=await f.start();
 expect(await within(9_000,f.send(s.id,'git 상태만 알려줘','gate-codex-refused-0001'))).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes[0]).toBe('\x1b,');
 expect(f.writes.slice(1).join('')).toBe('git 상태만 알려줘\r');
 expect(f.effort(s).runtimeStatus).toBeUndefined();
 expect(workroomEffortBadgeText(f.effort(s))).toBe('에포트 자동 · 이번 요청은 변경 안 함');
 const before=f.writes.length;
 expect(await within(5_000,f.send(s.id,'git 상태만 알려줘','gate-codex-refused-0002'))).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes.slice(before).join('')).toBe('git 상태만 알려줘\r');
},20_000);

/**
 * Codex 0.166 marks its composer 「»」 instead of 「›」 at `ultra` (measured 2026-10-31 on 3호 at none…max and ultra, the
 * same binary): a new 1호 OPS session at ultra refused every request as an unreadable draft before a byte was typed.
 */
const codexUltraIdle='\x1b[2J\x1b[H• Done.\r\n\r\n» Ask Codex to do anything\r\n\r\n  gpt-6.1-terra ultra · 100% context left\x1b[3;3H';
const codexUltraDraft='\x1b[2J\x1b[H• Done.\r\n\r\n» git log --oneline\r\n\r\n  gpt-6.1-terra ultra · 100% context left\x1b[3;20H';
test('a Codex composer at ultra (「»」) takes a request when empty and still keeps a real draft',async()=>{
 const f=fixture('codex',codexUltraIdle,{respond:(text,emit)=>{if(text==='\x1b,')emit(codexUltraIdle.replace('• Done.','■ Reasoning shortcuts are unavailable for gpt-6.1-terra.'));}}),s=await f.start();
 expect(await within(9_000,f.send(s.id,'git 상태만 알려줘','gate-codex-ultra-0001'))).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes.join('')).toEndWith('git 상태만 알려줘\r');
 const d=fixture('codex',codexUltraDraft),t=await d.start();
 const result=await within(9_000,d.send(t.id,'git 상태만 알려줘','gate-codex-ultra-draft-0001'));
 expect('error' in result&&result.error.message).toContain('CLI 입력칸에 작성 중이거나 확인할 수 없는 내용');
 expect(d.writes).toEqual([]);
},25_000);

/** A team leader still at work (team evidence, 2026-10-30): Claude 2.1.314 orchestrating, an empty composer, no effort glyph. */
const claudeBusy=`\x1b[2J\x1b[H ▐▛███▛█   Claude Code v2.1.314\r\n\r\n  Reading ego-browser usage guide · 26s\r\n\r\n✶ Orchestrating… (4m 56s · ↓ 17.3k tokens)\r\n${rule}\r\n❯ \r\n${rule}\r\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\x1b[7;3H`;
test('a busy team leader takes distinct requests one after another, and team follow-ups to a busy session arrive in order — each typed once, none held',async()=>{
 const f=fixture('claude',claudeBusy),s=await f.start();
 const requests=['첫 번째 확인 요청','두 번째 확인 요청','세 번째 확인 요청'],followUps=['팀원 후속 지시 하나','팀원 후속 지시 둘'];
 for(const [i,text] of requests.entries())
  expect(await within(2_500,f.send(s.id,text,`gate-leader-busy-000${i}`))).toEqual({value:expect.objectContaining({state:'written'})});
 // The leader's follow-ups to a member: host instructions under the team's receipt owner take the same write path.
 for(const [i,text] of followUps.entries())
  expect(await within(2_500,f.service.submitHostInstruction({id:`gate-team-followup-000${i}`,sessionId:s.id,data:text+'\r',receiptOwner:'workroom-team',skipCorrections:true}))).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes.join('')).toBe([...requests,...followUps].map(text=>text+'\r').join(''));
});

/** A real draft the person is typing in the CLI's own composer: plain text, the cursor after it. */
const claudeDraft=(effortLine='')=>`\x1b[2J\x1b[H ▐▛███▛█   Claude Code v2.1.314\r\n${effortLine}\r\n${rule}\r\n❯ git log --oneline\r\n${rule}\r\n  ⏸ manual mode on\x1b[4;22H`;
const codexDraft='\x1b[2J\x1b[H• Done.\r\n\r\n› git log --oneline\r\n\r\n  gpt-6.1-sol high · 100% context left\x1b[3;20H';
const refusesIntoDraft=async(f:ReturnType<typeof fixture>,s:{id:string;targetId:string},id:string,ms:number)=>{
 const result=await within(ms,f.send(s.id,'git 상태만 알려줘',id));
 expect('error' in result&&result.error.message).toContain('CLI 입력칸에 작성 중이거나 확인할 수 없는 내용');
 // Not one byte of the request, nothing typed over the person's draft, and the same id never written later.
 expect(f.writes).toEqual([]);
 expect(await f.status(s.id,id)).toBe('rejected');
 expect((await f.send(s.id,'git 상태만 알려줘',id)).state).toBe('rejected');
 expect(f.writes).toEqual([]);
};
test('a real draft in the Claude composer with a readable effort: after the 4 s wait the request is refused, not typed into it',async()=>{
 const f=fixture('claude',claudeDraft(claudeEffortRow)),s=await f.start();
 await refusesIntoDraft(f,s,'gate-claude-draft-0001',9_000);
 // The effort did not move and the advice says only that.
 const view=f.effort(s);
 expect(view.runtimeStatus).toBeUndefined();
 expect(workroomEffortAdviceText(view)).toBe('에포트는 지금 xhigh 그대로입니다 · 이번 요청의 권장 보통으로 바꾸지 않았습니다 · 바꾸려면 「에포트 변경」');
},15_000);
test('a real draft in the Claude composer with an effort the CLI does not show: refused at once, not typed into it',async()=>{
 const f=fixture('claude',claudeDraft()),s=await f.start();
 await refusesIntoDraft(f,s,'gate-claude-draft-unreadable-0001',2_500);
});
test('a draft typed while the leader works: the fresh composer read refuses it, even though the composer was empty before',async()=>{
 const busy=claudeBusy.replace('\r\n\r\n  Reading',`\r\n${claudeEffortRow}\r\n  Reading`).replace('\x1b[7;3H','\x1b[7;3H');
 const f=fixture('claude',busy),s=await f.start();
 setTimeout(()=>f.emit(busy.replace('❯ \r\n','❯ git log --oneline\r\n').replace('\x1b[7;3H','\x1b[7;22H')),1_000);
 await refusesIntoDraft(f,s,'gate-leader-draft-0001',9_000);
},15_000);
test('a real draft in the Codex composer: refused before the write fence, not typed into it',async()=>{
 const f=fixture('codex',codexDraft),s=await f.start();
 await refusesIntoDraft(f,s,'gate-codex-draft-0001',9_000);
},15_000);
test('a CLI that cannot be switched at run time keeps its plain write path: no composer proof is asked of it',async()=>{
 const f=fixture('claude',claudeDraft(claudeEffortRow),{switchable:false}),s=await f.start();
 expect(await within(2_500,f.send(s.id,'git 상태만 알려줘','gate-claude-plain-0001'))).toEqual({value:expect.objectContaining({state:'written'})});
 expect(f.writes.join('')).toBe('git 상태만 알려줘\r');
});
