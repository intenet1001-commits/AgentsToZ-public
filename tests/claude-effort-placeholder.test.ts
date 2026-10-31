import {expect,test} from 'bun:test';
import {AiTerminalScreen} from '../src/aiTerminalScreen';
import {changeWorkroomEffort,effortComposerEmpty,type EffortRefusal} from '../src/workroomEffortRuntime';

// Observed Claude Code 2.1.308 chrome; no account output or real model call.
const rule='─'.repeat(70),hint='Try "write a test for <filepath>"';
function render(screen:AiTerminalScreen,{dim=true,cursor=2,level='xhigh',text=hint}={}){
 screen.write(`\x1b[H\x1b[2JSet effort level to ${level}\r\n${rule}\r\n❯\u00a0${dim?'\x1b[2m':''}${text}\x1b[0m\r\n${rule}\r\n  manual mode on\x1b[3;${cursor+1}H`,1);
}
test('the real dimmed Claude placeholder is empty; identical user text at Home is still protected',async()=>{
 const screen=new AiTerminalScreen(80,8);
 try{
  render(screen);const frame=await screen.plainRows();expect(effortComposerEmpty(frame,'claude')).toBe(true);expect(effortComposerEmpty(frame,'codex')).toBe(false);
  render(screen,{dim:false});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render(screen,{cursor:3});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render(screen,{cursor:2+hint.length});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  // A draft is never drawn dim, even with its cursor at Home. (Since 2.1.314 a dimmed row at Home is any next-prompt
  // suggestion, not only 「Try "…"」 — see the 2.1.314 tests below.)
  render(screen,{dim:false,text:'preserve my draft'});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render(screen,{text:hint});screen.write('\x1b[2;1Hnot composer chrome\x1b[K\x1b[3;3H',2);expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
 }finally{screen.dispose();}
});
test('Claude session-only effort round trip accepts its dimmed placeholder again without submitting the hint',async()=>{
 const screen=new AiTerminalScreen(80,8),writes:string[]=[];let level='xhigh';render(screen);
 try{
  const result=await changeWorkroomEffort({agent:'claude',level:'high',current:level,timeoutMs:10,read:()=>screen.plainRows(),active:()=>true,idle:()=>true,claudeSessionPicker:true,codexDefaultKeys:false,sleep:async()=>{},write:data=>{
   writes.push(data);
   if(data==='/effort\r')screen.write('\x1b[H\x1b[2J'+'   Effort\r\n\r\n         Faster                             Smarter\r\n         ──────────────────────────────▲───────────\r\n         low     medium     high     xhigh      max\r\n\r\n   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel',2);
   else if(data==='\x1b[D')level='high';
   else if(data==='s')render(screen,{level});
  }});
  expect(result).toBe('applied');expect(writes).toEqual(['/effort\r','\x1b[D','s']);
 }finally{screen.dispose();}
});
test('dimmed Claude hint cannot bypass a busy response or a pending approval',async()=>{
 const screen=new AiTerminalScreen(80,8),writes:string[]=[];render(screen);
 try{
  const control={agent:'claude' as const,level:'high' as const,current:'xhigh',read:()=>screen.plainRows(),write:(s:string)=>{writes.push(s);},active:()=>true,idle:()=>false,claudeSessionPicker:true,codexDefaultKeys:false,timeoutMs:0};
  await expect(changeWorkroomEffort(control)).rejects.toThrow('진행 중');expect(writes).toEqual([]);
  const frame=(await screen.plainRows())!;frame.rows[0]='Do you trust this folder?';expect(effortComposerEmpty(frame,'claude')).toBe(false);
 }finally{screen.dispose();}
});

// Observed Claude Code 2.1.314 after a turn (live Workroom, 2026-10-30): the next-prompt suggestion is drawn dimmed in the
// composer with the cursor at Home, between the composer rules. Any words — the suggestion is the CLI's own guess.
const suggestion='WR-SEND-DIAG-C3 마커 한 줄과 현재 브랜치명만 출력하세요.';
function render2314(screen:AiTerminalScreen,{typed='',ghost=suggestion,dim=true,cursor=undefined as number|undefined,below=rule,effort=''}={}){
 cursor??=2+typed.length;
 screen.write(`\x1b[H\x1b[2J✻ Crunched for 2s\r\n${effort}\r\n${rule}\r\n❯ ${typed}${dim?'\x1b[2m':''}${ghost}\x1b[0m\r\n${below}\r\n  ⏸ manual mode on\x1b[4;${cursor+1}H`,1);
}
test('Claude 2.1.314: its dimmed next-prompt suggestion is an empty composer; a real draft never is',async()=>{
 const screen=new AiTerminalScreen(90,8);
 try{
  render2314(screen);expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(true);
  // The same words typed by the person (not dim), with the cursor at Home or after them.
  render2314(screen,{dim:false});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render2314(screen,{dim:false,cursor:2+suggestion.length});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  // A draft being typed with the CLI's dimmed completion after it: the cursor is past the draft.
  render2314(screen,{typed:'git ',ghost:'status 알려줘'});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  // Not exactly at Home, or not one row between the composer rules (a wrapped or multi-line composer).
  render2314(screen,{cursor:3});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  render2314(screen,{below:'  두 번째 줄'});expect(effortComposerEmpty(await screen.plainRows(),'claude')).toBe(false);
  // Codex reads the same frame as a draft: the suggestion rule is Claude's.
  render2314(screen);expect(effortComposerEmpty(await screen.plainRows(),'codex')).toBe(false);
 }finally{screen.dispose();}
});
test('Claude 2.1.314 session-only change from its suggestion screen, reading 「◉ xhigh · /effort」',async()=>{
 const screen=new AiTerminalScreen(90,8),writes:string[]=[];let level='xhigh';
 render2314(screen,{effort:'                                        ◉ xhigh · /effort'});
 try{
  const result=await changeWorkroomEffort({agent:'claude',level:'medium',current:undefined,timeoutMs:10,read:()=>screen.plainRows(),active:()=>true,idle:()=>true,claudeSessionPicker:true,codexDefaultKeys:false,sleep:async()=>{},write:data=>{
   writes.push(data);
   if(data==='/effort\r')screen.write('\x1b[H\x1b[2J'+'   Effort\r\n\r\n         Faster                             Smarter\r\n         ──────────────────────────────▲───────────\r\n         low     medium     high     xhigh      max\r\n\r\n   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel',2);
   else if(data==='\x1b[D')level=level==='xhigh'?'high':'medium';
   else if(data==='s')render2314(screen,{effort:`  ⎿ Set effort level to ${level} (this session only)`});
  }});
  expect(result).toBe('applied');expect(writes).toEqual(['/effort\r','\x1b[D','\x1b[D','s']);
 }finally{screen.dispose();}
});
// Codex 0.166 shows 「Ask a follow-up question」 (binary strings, 2026-10-30) once a conversation has a turn.
function renderCodex(screen:AiTerminalScreen,{text='Ask a follow-up question',dim=true,cursor=2}={}){
 screen.write(`\x1b[H\x1b[2J• Done.\r\n\r\n› ${dim?'\x1b[2m':''}${text}\x1b[0m\r\n\r\n  gpt-6.1-sol high · 100% context left\x1b[3;${cursor+1}H`,1);
}
test('Codex 0.166: its dimmed follow-up placeholder is an empty composer; the same words as a draft are not',async()=>{
 const screen=new AiTerminalScreen(90,6);
 try{
  renderCodex(screen);expect(effortComposerEmpty(await screen.plainRows(),'codex')).toBe(true);
  renderCodex(screen,{dim:false});expect(effortComposerEmpty(await screen.plainRows(),'codex')).toBe(false);
  renderCodex(screen,{cursor:2+'Ask a follow-up question'.length});expect(effortComposerEmpty(await screen.plainRows(),'codex')).toBe(false);
  renderCodex(screen,{text:'Ask a follow-up question about the tests'});expect(effortComposerEmpty(await screen.plainRows(),'codex')).toBe(false);
 }finally{screen.dispose();}
});

// Claude 2.1.314's slider (live probe at 60, 90 and 105×11, 2026-10-31). At 60 columns its footer wraps after
// 「s for this session」; at 12 rows or fewer it falls below the screen.
const slider=(footer:string[],above='')=>'\x1b[H\x1b[2J'+(above?above+'\r\n\r\n':'')+'   Effort\r\n\r\n         Faster                             Smarter\r\n         ──────────────────────────────▲───────────\r\n         low     medium     high     xhigh      max\r\n      ~2.5x the estimated cost of medium (the default)\r\n'+footer.join('\r\n');
const narrowRule='─'.repeat(50);
const atRest=(level:string,line='')=>`\x1b[H\x1b[2J${line}\r\n                    ${level==='medium'?'◐':'◉'} ${level} · /effort\r\n${narrowRule}\r\n❯ \r\n${narrowRule}\x1b[${line.split('\r\n').length+3};3H`;
function claudeControl(screen:AiTerminalScreen,respond:(data:string)=>void,extra:Partial<Parameters<typeof changeWorkroomEffort>[0]>={}){
 const writes:string[]=[];
 return {writes,control:{agent:'claude' as const,level:'medium' as const,current:'xhigh',timeoutMs:10,read:()=>screen.plainRows(),active:()=>true,idle:()=>true,
  claudeSessionPicker:true,codexDefaultKeys:false,sleep:async()=>{},write:(data:string)=>{writes.push(data);respond(data);},...extra}};
}
test('a footer wrapped on a narrow screen still proves 「s for this session only」',async()=>{
 const screen=new AiTerminalScreen(60,16);let level='xhigh';screen.write(atRest(level),1);
 try{
  const {writes,control}=claudeControl(screen,data=>{
   if(data==='/effort\r')screen.write(slider(['   ←/→ to adjust · Enter to confirm · s for this session','   only · Esc to cancel']),2);
   else if(data==='\x1b[D')level=level==='xhigh'?'high':'medium';
   else if(data==='s')screen.write(atRest(level,`  ⎿  Set effort level to ${level} (this session only)`),3);
  });
  expect(await changeWorkroomEffort(control)).toBe('applied');expect(writes).toEqual(['/effort\r','\x1b[D','\x1b[D','s']);
 }finally{screen.dispose();}
});
test('a slider with its footer cut off is cancelled, never confirmed, and the screen size is remembered',async()=>{
 const screen=new AiTerminalScreen(105,11);screen.write(atRest('xhigh'),1);const refused:EffortRefusal[]=[];
 try{
  const clip=(data:string,n:number)=>{
   if(data==='/effort\r')screen.write(slider([]),n);
   else if(data==='\x1b')screen.write(atRest('xhigh','❯ /effort\r\n  ⎿  Cancelled'),n+1);
  };
  const {writes,control}=claudeControl(screen,data=>clip(data,2),{cols:105,refused:refusal=>{refused.push(refusal);}});
  expect(await changeWorkroomEffort(control)).toBe('unchanged');
  expect(writes).toEqual(['/effort\r','\x1b']);expect(refused).toEqual([{rows:11,cols:105}]);
  // At that size, or a narrower one that wraps the footer onto more rows, nothing is typed again.
  for(const cols of [105,80]){
   const again=claudeControl(screen,()=>{},{cols,refusal:refused[0]});
   expect(await changeWorkroomEffort(again.control)).toBe('unsupported');expect(again.writes).toEqual([]);
  }
  // A wider screen may fit a footer a narrow one wrapped away, so it tries again.
  const wider=claudeControl(screen,data=>clip(data,4),{cols:105,refusal:{rows:11,cols:60}});
  expect(await changeWorkroomEffort(wider.control)).toBe('unchanged');expect(wider.writes).toEqual(['/effort\r','\x1b']);
 }finally{screen.dispose();}
});
test('a slider that never confirms `s` is cancelled back to the level it had; a cancel the screen does not prove keeps the refusal',async()=>{
 const screen=new AiTerminalScreen(90,16);screen.write(atRest('xhigh'),1);
 try{
  const footer=['   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'];
  const {writes,control}=claudeControl(screen,data=>{
   if(data==='/effort\r')screen.write(slider(footer),2);
   else if(data==='\x1b')screen.write(atRest('xhigh','  ⎿  Cancelled'),3);
  });
  expect(await changeWorkroomEffort(control)).toBe('unchanged');expect(writes).toEqual(['/effort\r','\x1b[D','\x1b[D','s','\x1b']);
  screen.write(atRest('xhigh'),4);
  const stuck=claudeControl(screen,data=>{if(data==='/effort\r')screen.write(slider(footer),5);});
  await expect(changeWorkroomEffort(stuck.control)).rejects.toThrow('확인하지 못했습니다');expect(stuck.writes).toEqual(['/effort\r','\x1b[D','\x1b[D','s','\x1b']);
 }finally{screen.dispose();}
});
test('Codex says its shortcuts wait for startup: nothing moved, the request may go on, and the refusal is not remembered',async()=>{
 const screen=new AiTerminalScreen(90,6);renderCodex(screen,{text:'Ask Codex to do anything',dim:false});const refused:EffortRefusal[]=[];
 try{
  const writes:string[]=[];
  const result=await changeWorkroomEffort({agent:'codex',level:'medium',current:'high',timeoutMs:10,read:()=>screen.plainRows(),active:()=>true,idle:()=>true,
   claudeSessionPicker:false,codexDefaultKeys:true,sleep:async()=>{},refused:refusal=>{refused.push(refusal);},write:data=>{writes.push(data);
    screen.write('\x1b[H\x1b[2J• Reasoning shortcuts are disabled until startup completes.\r\n\r\n› Ask Codex to do anything\r\n\r\n  gpt-6.1-sol high · 100% context left\x1b[3;3H',2);}});
  expect(result).toBe('unchanged');expect(writes).toEqual(['\x1b,']);expect(refused).toEqual([]);
 }finally{screen.dispose();}
});

// 2026-10-31 review: a transcript row that names levels is not the slider. The old whole-screen match refused a valid
// change, picked the wrong arrow count, or typed Escape into the composer when no slider had opened.
for(const above of ['  Severity: low / medium / high',"  const LEVELS = ['low', 'medium', 'high'];"]){
 test(`a transcript row 「${above.trim()}」 above a real slider does not stop the change`,async()=>{
  const screen=new AiTerminalScreen(105,30);let level='xhigh';screen.write(atRest(level,above),1);
  try{
   const {writes,control}=claudeControl(screen,data=>{
    if(data==='/effort\r')screen.write(slider(['   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'],above),2);
    else if(data==='\x1b[D')level=level==='xhigh'?'high':'medium';
    else if(data==='s')screen.write(atRest(level,`${above}\r\n  ⎿  Set effort level to ${level} (this session only)`),3);
   });
   expect(await changeWorkroomEffort(control)).toBe('applied');expect(writes).toEqual(['/effort\r','\x1b[D','\x1b[D','s']);
  }finally{screen.dispose();}
 });
}
test('levels are counted on the slider, not on a transcript row naming fewer of them',async()=>{
 const above='  low medium high max';const order=['low','medium','high','xhigh','max'];
 const screen=new AiTerminalScreen(105,30);let level='max';screen.write(atRest(level,above),1);
 try{
  const {writes,control}=claudeControl(screen,data=>{
   if(data==='/effort\r')screen.write(slider(['   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel'],above),2);
   else if(data==='\x1b[D')level=order[order.indexOf(level)-1]!;
   else if(data==='s')screen.write(atRest(level,`${above}\r\n  ⎿  Set effort level to ${level} (this session only)`),3);
  },{level:'high',current:'max'});
  expect(await changeWorkroomEffort(control)).toBe('applied');expect(writes).toEqual(['/effort\r','\x1b[D','\x1b[D','s']);expect(level).toBe('high');
 }finally{screen.dispose();}
});
test('a slider that never opened is never cancelled: no Escape reaches the composer',async()=>{
 const above='  levels: low medium high';
 const screen=new AiTerminalScreen(105,30);screen.write(atRest('xhigh',above),1);
 try{
  const {writes,control}=claudeControl(screen,()=>{});
  await expect(changeWorkroomEffort(control)).rejects.toThrow('확인하지 못했습니다');expect(writes).toEqual(['/effort\r']);
 }finally{screen.dispose();}
});
const codexAt=(screen:AiTerminalScreen,row:string,level:string,n:number,model='gpt-6-sol')=>
 screen.write(`\x1b[H\x1b[2J${row}\r\n\r\n› \x1b[2mAsk a follow-up question\x1b[0m\r\n\r\n  ${model} ${level} · 100% context left\x1b[3;3H`,n);
test('Codex output quoting the refusal while a shortcut applies is not a refusal',async()=>{
 const screen=new AiTerminalScreen(100,8);codexAt(screen,'• Working (streaming)','medium',1);
 const quote='  docs: 「Reasoning shortcuts are unavailable for gpt-6.1-sol」 is a refusal.';
 const writes:string[]=[];const refused:EffortRefusal[]=[];let pending=false;
 try{
  const result=await changeWorkroomEffort({agent:'codex',level:'high',current:'medium',timeoutMs:10,claudeSessionPicker:false,codexDefaultKeys:true,
   read:async()=>{const f=await screen.plainRows();if(pending){pending=false;codexAt(screen,quote,'high',9);}return f;},
   active:()=>true,idle:()=>true,sleep:async()=>{},refused:refusal=>{refused.push(refusal);},
   write:data=>{writes.push(data);codexAt(screen,quote,'medium',2);pending=true;}});
  expect(result).toBe('applied');expect(writes).toEqual(['\x1b.']);expect(refused).toEqual([]);
 }finally{screen.dispose();}
});
test('a Codex refusal whose footer then moves is a partial change, never a quiet go-ahead',async()=>{
 const screen=new AiTerminalScreen(100,8);codexAt(screen,'• Done.','medium',1);
 const writes:string[]=[];const refused:EffortRefusal[]=[];let after=0;
 try{
  await expect(changeWorkroomEffort({agent:'codex',level:'high',current:'medium',timeoutMs:10,claudeSessionPicker:false,codexDefaultKeys:true,
   read:async()=>{if(after&&++after===3)codexAt(screen,'• Reasoning shortcuts are unavailable for gpt-6-sol.','high',9);return screen.plainRows();},
   active:()=>true,idle:()=>true,sleep:async()=>{},refused:refusal=>{refused.push(refusal);},
   write:data=>{writes.push(data);codexAt(screen,'• Reasoning shortcuts are unavailable for gpt-6-sol.','medium',2);after=1;}})).rejects.toThrow('예상과 다릅니다');
  expect(writes).toEqual(['\x1b.']);expect(refused).toEqual([]);
 }finally{screen.dispose();}
});
test('a Codex model that refused its shortcuts is skipped; another model tries again',async()=>{
 const screen=new AiTerminalScreen(100,8);codexAt(screen,'• Done.','medium',1,'gpt-6.1-sol');
 const run=(refusal?:EffortRefusal)=>{const writes:string[]=[];const refused:EffortRefusal[]=[];
  return {writes,refused,result:changeWorkroomEffort({agent:'codex',level:'high',current:'medium',timeoutMs:10,claudeSessionPicker:false,codexDefaultKeys:true,
   read:()=>screen.plainRows(),active:()=>true,idle:()=>true,sleep:async()=>{},refusal,refused:r=>{refused.push(r);},
   write:data=>{writes.push(data);codexAt(screen,'• Reasoning shortcuts are unavailable for gpt-6.1-sol.','medium',2,'gpt-6.1-sol');}})};};
 try{
  const first=run();expect(await first.result).toBe('unchanged');expect(first.writes).toEqual(['\x1b.']);expect(first.refused).toEqual([{model:'gpt-6.1-sol'}]);
  const same=run({model:'gpt-6.1-sol'});expect(await same.result).toBe('unsupported');expect(same.writes).toEqual([]);
  codexAt(screen,'• Model changed to gpt-6-sol medium','medium',3);
  const other=run({model:'gpt-6.1-sol'});expect(await other.result).toBe('unchanged');expect(other.writes).toEqual(['\x1b.']);
 }finally{screen.dispose();}
});
// Claude 2.1.314 at 50 and 40 columns (live tmux probe, 2026-10-31). At 50 the slider is whole and the footer wraps; at 40
// its rows are cut at both sides, so the levels cannot be counted: the slider is cancelled and only the width remembered.
const slider50=['   Effort','','    Faster                             Smarter','    ──────────────────────────────▲───────────',
 '    low     medium     high     xhigh      max','','     ~2.5x the estimated cost of medium (the','     default)','','                  Ultracode  off',
 '                  Tab to toggle','','   ←/→ to adjust · Enter to confirm · s for','   this session only · Esc to cancel'];
const slider40=['   Effort','','aster                             Smarte','─────────────────────────────▲──────────',
 'ow     medium     high     xhigh      ma','                                      x','','','','   ~2.5x the estimated cost of medium','   (the default)','',
 '             Ultracode  off','             Tab to toggle','','   ←/→ to adjust · Enter to confirm ·','   s for this session only · Esc to','   cancel'];
const shortRule='─'.repeat(30);
const restAt=(level:string,line='')=>`\x1b[H\x1b[2J${line}\r\n          ${level==='medium'?'◐':'◉'} ${level} · /effort\r\n${shortRule}\r\n❯ \r\n${shortRule}\x1b[${line.split('\r\n').length+3};3H`;
test('a whole slider at 50 columns with its footer wrapped is applied',async()=>{
 const screen=new AiTerminalScreen(50,30);let level='xhigh';screen.write(restAt(level),1);
 try{
  const {writes,control}=claudeControl(screen,data=>{
   if(data==='/effort\r')screen.write('\x1b[H\x1b[2J'+slider50.join('\r\n'),2);
   else if(data==='\x1b[D')level=level==='xhigh'?'high':'medium';
   else if(data==='s')screen.write(restAt(level,`  ⎿  Set effort level to ${level}`),3);
  },{cols:50});
  expect(await changeWorkroomEffort(control)).toBe('applied');expect(writes).toEqual(['/effort\r','\x1b[D','\x1b[D','s']);
 }finally{screen.dispose();}
});
test('a slider cut at the sides on a narrow screen is cancelled, and only the width is remembered',async()=>{
 const screen=new AiTerminalScreen(40,30);screen.write(restAt('xhigh'),1);const refused:EffortRefusal[]=[];
 try{
  const narrow=(data:string,n:number)=>{
   if(data==='/effort\r')screen.write('\x1b[H\x1b[2J'+slider40.join('\r\n'),n);
   else if(data==='\x1b')screen.write(restAt('xhigh','  ⎿  Cancelled'),n+1);
  };
  const {writes,control}=claudeControl(screen,data=>narrow(data,2),{cols:40,refused:refusal=>{refused.push(refusal);}});
  expect(await changeWorkroomEffort(control)).toBe('unchanged');expect(writes).toEqual(['/effort\r','\x1b']);expect(refused).toEqual([{cols:40}]);
  // Any height at that width or narrower types nothing; a wider screen tries again.
  for(const cols of [40,34]){const again=claudeControl(screen,()=>{},{cols,refusal:refused[0]});expect(await changeWorkroomEffort(again.control)).toBe('unsupported');expect(again.writes).toEqual([]);}
  const wider=claudeControl(screen,data=>narrow(data,4),{cols:60,refusal:refused[0]});
  expect(await changeWorkroomEffort(wider.control)).toBe('unchanged');expect(wider.writes).toEqual(['/effort\r','\x1b']);
 }finally{screen.dispose();}
});
test('a Codex refusal is remembered whatever case the footer writes the model in',async()=>{
 const screen=new AiTerminalScreen(100,8);codexAt(screen,'• Done.','high',1,'GPT-6.1-Sol');
 try{
  const writes:string[]=[];
  const result=await changeWorkroomEffort({agent:'codex',level:'medium',current:'high',timeoutMs:10,claudeSessionPicker:false,codexDefaultKeys:true,
   read:()=>screen.plainRows(),active:()=>true,idle:()=>true,sleep:async()=>{},refusal:{model:'gpt-6.1-sol'},write:data=>{writes.push(data);}});
  expect(result).toBe('unsupported');expect(writes).toEqual([]);
 }finally{screen.dispose();}
});
