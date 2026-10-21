import {expect,test} from 'bun:test';
import {ExternalCliEffort,externalCliPrompt,externalCodexDraft} from '../src/externalCliEffort';
import {externalCliEffortCommand,externalCliEffortLauncher} from '../src/externalCliEffortCommand';
import type {EffortFrame} from '../src/workroomEffortRuntime';
import type {WorkroomEffortMode} from '../src/workroomEffortMode';
import {stringWidth} from 'bun';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkroomEffortSetting} from '../src/workroomEffortSetting';

function fixture(text='보안 설계 검토', initial='medium') {
  let draft=text, level=initial, mode:WorkroomEffortMode='auto', active=true, refused=false, allowed=true;
  const writes:string[]=[], notices:string[]=[];
  const frame=():EffortFrame => ({rows:[`model: gpt-6.1-sol ${level}`,'› '+draft,''],cursorRow:1,cursorCol:stringWidth('› '+draft),alternate:false});
  const host=new ExternalCliEffort({agent:'codex',claudeSessionPicker:false,codexDefaultKeys:true,
    mode:()=>mode,active:()=>active,idle:()=>true,allowed:()=>allowed,
    read:async()=>frame(),sleep:async()=>{},notice:m=>notices.push(m),
    write:data=>{writes.push(data);if(data==='\x15')draft='';if(data==='\x1b.'&&!refused)level='high';if(data==='\x1b,'&&!refused)level=level==='xhigh'?'high':'low';},
    paste:async text=>{writes.push('paste:'+text);draft=text;},
  });
  return {host,writes,notices,frame,get draft(){return draft;},get level(){return level;},set mode(v:WorkroomEffortMode){mode=v;},set active(v:boolean){active=v;},set refused(v:boolean){refused=v;},set allowed(v:boolean){allowed=v;}};
}

test('Codex adjusts the exact request without clearing or pasting it before the only Enter',async()=>{
  const f=fixture();await f.host.enter();
  expect(f.level).toBe('high');expect(f.draft).toBe('보안 설계 검토');
  expect(f.writes).toEqual(['\x1b.','\r']);
});
test('off and unverified controls leave native input untouched',async()=>{
  for(const mode of ['off','auto'] as const){const f=fixture();f.mode=mode;if(mode==='auto')f.allowed=false;await f.host.enter();expect(f.writes).toEqual(['\r']);}
});
test('recommend mode gives advice without native settings writes',async()=>{
  const f=fixture();f.mode='recommend';await f.host.enter();expect(f.writes).toEqual(['\r']);expect(f.notices[0]).toContain('high');
});
test('auto re-evaluates manual xhigh; OFF keeps it fixed',async()=>{
  const high=fixture('오타 수정','xhigh');await high.host.enter();expect(high.level).toBe('low');
  expect(high.writes).toEqual(['\x1b,','\x1b,','\r']);
  const fixed=fixture('오타 수정','xhigh');fixed.mode='off';await fixed.host.enter();expect(fixed.writes).toEqual(['\r']);expect(fixed.level).toBe('xhigh');
  const command=fixture('/model');await command.host.enter();expect(command.writes).toEqual(['\r']);
});
test('an unconfirmed native setting restores the draft and does not replay Enter',async()=>{
  const f=fixture();f.refused=true;await f.host.enter();expect(f.draft).toBe('보안 설계 검토');
  expect(f.writes).not.toContain('\r');expect(f.notices.length).toBeGreaterThan(0);
  await f.host.enter();expect(f.writes.at(-1)).toBe('\r');
});
test('a changed mode is read for every subsequent external request',async()=>{
  const f=fixture();f.mode='off';await f.host.enter();f.mode='auto';await f.host.enter();expect(f.level).toBe('high');
});
test('partial, wrapped, multiline, approval and mid-line input are never removed',()=>{
  const f=fixture();expect(externalCliPrompt(f.frame())).toBe('보안 설계 검토');
  expect(externalCliPrompt({...f.frame(),cursorCol:3})).toBeNull();
  expect(externalCliPrompt({...f.frame(),rows:['model: gpt-6.1-sol medium','› first','second']})).toBeNull();
  expect(externalCliPrompt({...f.frame(),rows:['Do you want to proceed?','1. Yes','2. No']})).toBeNull();
});
test('Codex keeps a visible multiline draft and its middle cursor intact while adjusting effort',async()=>{
  let level='medium';const writes:string[]=[];
  const read=async():Promise<EffortFrame>=>({rows:[`model: gpt-6.1-sol ${level}`,'› 다음 보안 설계의','  권한 격리를 검토해줘',''],cursorRow:1,cursorCol:8,alternate:false});
  const original=await read(),draft=externalCodexDraft(original);expect(draft?.text).toBe('다음 보안 설계의\n권한 격리를 검토해줘');
  const host=new ExternalCliEffort({agent:'codex',codexDefaultKeys:true,claudeSessionPicker:false,mode:()=> 'auto',active:()=>true,idle:()=>true,allowed:()=>true,
    read,write:data=>{writes.push(data);if(data==='\x1b.')level='high';},paste:async()=>{throw Error('must not paste');},notice:()=>{},sleep:async()=>{}});
  await host.enter();expect(writes).toEqual(['\x1b.','\r']);expect(draft?.stable(await read())).toBe(true);
  expect(draft?.stable({...original,cursorCol:9})).toBe(false);
  expect(draft?.stable({...original,rows:[original.rows[0]!,'› 다른 요청',original.rows[2]!, '']})).toBe(false);
});
test('a Codex draft changed during the native setting write is never submitted',async()=>{
  const f=fixture();let level='medium',changed=false;const writes:string[]=[],notices:string[]=[];
  const host=new ExternalCliEffort({agent:'codex',codexDefaultKeys:true,claudeSessionPicker:false,mode:()=> 'auto',active:()=>true,idle:()=>true,allowed:()=>true,
    read:async()=>({...f.frame(),rows:[`model: gpt-6.1-sol ${level}`,changed?'› 다른 요청':'› 보안 설계 검토','']}),
    write:data=>{writes.push(data);level='high';changed=true;},paste:async()=>{throw Error('must not paste');},notice:m=>notices.push(m),sleep:async()=>{}});
  await host.enter();expect(writes).toEqual(['\x1b.']);expect(notices).toHaveLength(1);
});
test.skipIf(process.platform === 'win32')('POSIX command builder quotes every boundary and preserves native permissions',async()=>{
  const result=externalCliEffortCommand({agent:'codex',executable:'/some path/codex',command:"'/some path/codex' --dangerously-bypass-approvals-and-sandbox",appDataDir:"/tmp/owner's data",launcher:['/tmp/bun','/source/api-sidecar-entry.ts'],platform:'darwin'});
  // The shell returns argv as data; it does not execute the native CLI or any generated path.
  const script=result.replace("'/tmp/bun'", "printf '%s\\n'");
  const p=Bun.spawn(['/bin/sh','-c',script],{stdout:'pipe'});
  const args=(await new Response(p.stdout).text()).trim().split('\n');expect(await p.exited).toBe(0);
  expect(args).toEqual(['/source/api-sidecar-entry.ts','--agentstoz-effort-cli','codex','/some path/codex',"'/some path/codex' --dangerously-bypass-approvals-and-sandbox"]);
});
test('unsupported external CLI hosts keep the original native command',()=>{
  for(const platform of ['linux','win32'] as const){
    expect(externalCliEffortCommand({agent:'codex',executable:'codex',command:'codex --native-option',appDataDir:'/unused',launcher:['bun'],platform})).toBe('codex --native-option');
  }
});

test.skipIf(process.platform !== 'darwin')('the standalone macOS host adjusts and submits through a real isolated PTY without starting an API server or model',async()=>{
  const root=mkdtempSync(join(tmpdir(),'atz-external-effort-'));
  const appData=join(root,'app-data'),bin=join(root,'codex.ts');mkdirSync(appData);
  writeFileSync(join(root,'.env'),'ATZ_EFFORT_SENTINEL=unexpected\n');
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'@openai/codex',version:'0.163.0'}));
  writeFileSync(bin,`process.stdin.setRawMode(true);let draft='',level='medium';const draw=()=>process.stdout.write('\\x1b[2J\\x1b[Hmodel: gpt-6.1-sol '+level+'\\r\\n› '+draft+'\\x1b[K');process.stdin.on('data',bytes=>{const text=bytes.toString();if(text==='\\x15')draft='';else if(text==='\\x1b.')level='high';else if(text==='\\x1b,')level='low';else if(text==='\\r'){process.stdout.write('\\r\\nRECEIPT:'+JSON.stringify({draft,level,unexpected:process.env.ATZ_EFFORT_SENTINEL})+'\\r\\n');process.exit(0);}else draft+=text;draw();});draw();`);
  let output='';
  const binary=process.env.ATZ_EFFORT_HOST_TEST_BINARY;
  const launcher=externalCliEffortLauncher(binary??process.execPath,resolve(import.meta.dir,'..'),!!binary);
  const child=(Bun.spawn as any)([...launcher,'--agentstoz-effort-cli','codex',bin,`'${process.execPath}' --no-env-file '${bin}'`],{
    cwd:root,env:{...process.env,HOME:root,CODEX_HOME:join(root,'.codex'),APP_DATA_DIR:appData},
    terminal:{cols:100,rows:28,data(_pty:unknown,bytes:Uint8Array){output+=new TextDecoder().decode(bytes);}},
  });
  const until=async(predicate:()=>boolean)=>{const end=Date.now()+7000;while(!predicate()){if(Date.now()>end)throw Error('PTY timeout: '+output.slice(-700));await Bun.sleep(20);}};
  try{
    await until(()=>output.includes('model: gpt-6.1-sol medium'));
    child.terminal.write('보안 설계 검토');await until(()=>output.includes('› 보안 설계 검토'));
    child.terminal.write('\r');await until(()=>output.includes('RECEIPT:'));
    expect(await child.exited).toBe(0);
    expect(output).toContain('RECEIPT:{"draft":"보안 설계 검토","level":"high"}');
  }finally{child.kill();child.terminal.close();rmSync(root,{recursive:true,force:true});}
},15000);
