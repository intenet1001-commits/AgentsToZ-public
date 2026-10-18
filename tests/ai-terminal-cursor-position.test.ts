import {expect, test, describe, afterEach} from 'bun:test';
import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AiTerminalScreen, AI_TERMINAL_CPR_ECHO_WINDOW_MS} from '../src/aiTerminalScreen';
import {stripViewerTerminalReplies, VIEWER_SPLIT_PART_MIN_CHARS, type ViewerReplyFilterState} from '../src/aiTerminalReplyFilter';
import {AiTerminalService, writeAiTerminalInput} from '../src/aiTerminalService';
import {splitTerminalInput} from '../src/aiTerminalInput';

const strip=(data:string,ambiguousIsReply=false,state={pasteOpen:false})=>stripViewerTerminalReplies(data,state,{ambiguousIsReply});

describe('the host answers cursor-position queries (CPR and DECXCPR)',()=>{
  test('CSI 6 n and CSI ? 6 n are answered at the PTY size, after a resize queued before them',async()=>{
    const replies:string[]=[];const screen=new AiTerminalScreen(100,28,undefined,d=>replies.push(d));
    screen.write('\x1b[28;90Hx',1);screen.resize(40,10);screen.write('\x1b[6n\x1b[?6n',2);
    await Bun.sleep(50);
    expect(replies).toEqual(['\x1b[10;40R','\x1b[?10;40R']);screen.dispose();
  });
  test('a pending wrap reports the last column, not cols+1',async()=>{
    const replies:string[]=[];const screen=new AiTerminalScreen(10,5,undefined,d=>replies.push(d));
    screen.write('\x1b[1;1H0123456789\x1b[6n',1);await Bun.sleep(50);
    expect(replies).toEqual(['\x1b[1;10R']);screen.dispose();
  });
  test('the echo window opens only with a plain CPR answer',async()=>{
    let now=1_000;const screen=new AiTerminalScreen(80,24,()=>now,()=>{});
    expect(screen.answeredPlainCursorRecently()).toBe(false);
    screen.write('\x1b[?6n',1);await Bun.sleep(30);expect(screen.answeredPlainCursorRecently()).toBe(false);
    screen.write('\x1b[6n',2);await Bun.sleep(30);expect(screen.answeredPlainCursorRecently()).toBe(true);
    now+=AI_TERMINAL_CPR_ECHO_WINDOW_MS+1;expect(screen.answeredPlainCursorRecently()).toBe(false);screen.dispose();
  });
});

describe('a viewer-forwarded reply is a duplicate and never reaches the CLI',()=>{
  test('DA, DECXCPR and unambiguous CPR are removed, even glued to typing',()=>{
    expect(strip('a\x1b[>0;276;0cb\x1b[?1;2c')).toBe('ab');
    expect(strip('\x1b[?1;2R')).toBe('');
    expect(strip('x\x1b[12;40Ry\x1b[1;1R\x1b[1;17R')).toBe('xy');
  });
  test('Shift/Ctrl+F3 (CSI 1;m R) stays a key unless it is a reply here',()=>{
    expect(strip('\x1b[1;2R')).toBe('\x1b[1;2R');
    expect(strip('\x1b[1;5R')).toBe('\x1b[1;5R');
    expect(strip('\x1b[1;2R',true)).toBe('');
  });
  test('bracketed paste content is never edited, also across input requests',()=>{
    const state={pasteOpen:false};
    expect(strip('\x1b[200~keep \x1b[2;3R and \x1b[>c',false,state)).toBe('\x1b[200~keep \x1b[2;3R and \x1b[>c');
    expect(state.pasteOpen).toBe(true);
    expect(strip(' still \x1b[4;4R\x1b[201~\x1b[5;5R!',false,state)).toBe(' still \x1b[4;4R\x1b[201~!');
    expect(state.pasteOpen).toBe(false);
  });
  test('ordinary keys and IME text pass unchanged',()=>{
    for(const key of ['\r','\x1b','\x1b[A','\x1bOA','\x1b[Z','\x1b[3~','\x1bOR','한글 입력','\x1b[I','\x1b[O'])expect(strip(key)).toBe(key);
  });
});

const posix=process.platform!=='win32';
(posix?describe:describe.skip)('end to end with a real PTY',()=>{
  const dirs:string[]=[];const services:AiTerminalService[]=[];
  afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.shutdown()));for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
  const req=(r:any)=>({...r,requestId:crypto.randomUUID()});
  test('only the host answers; a forwarded reply is dropped without bumping the input revision',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'agentstoz-cpr-'));dirs.push(dir);
    const cli=join(dir,'cli');
    writeFileSync(cli,`#!/bin/sh\nstty raw -echo\nprintf 'READY\\r\\n'\nprintf '\\033[6n'\nwhile :; do c=$(dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' '); printf '[%s]' "$c"; done\n`);chmodSync(cli,0o755);
    const service=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>cli});services.push(service);
    const id=(await service.perform(req({operation:'start',targetId:'project-fixture-123',agent:'claude',cols:80,rows:24}))).session!.id;
    let text='',cursor=0;const read=async(until:string)=>{const end=Date.now()+4000;while(Date.now()<end){const r=await service.perform(req({operation:'read',sessionId:id,after:cursor}));for(const c of r.chunks??[]){text+=c.text;cursor=c.seq;}if(text.includes(until))return;await Bun.sleep(20);}throw new Error('missing '+until+' in '+JSON.stringify(text));};
    await read('[R]');                                   // the host's own answer: ESC [ 2 ; 1 R
    expect(text).toContain('[033][[][2][;][1][R]');
    const before=service.inspectSession(id,'project-fixture-123').inputRevision;
    await service.perform(req({operation:'input',sessionId:id,data:'\x1b[2;1R'}));   // a viewer's duplicate
    await service.perform(req({operation:'input',sessionId:id,data:'z'}));
    await read('[z]');
    expect(text.split('[R]').length-1).toBe(1);
    expect(service.inspectSession(id,'project-fixture-123').inputRevision).toBe(before+1);
  });
});

/**
 * A stand-in for Codex 0.160 (crossterm): on every PTY size change it asks `CSI 6 n` and stops reading keys
 * until the answer comes or 2 s pass; the keys read meanwhile are handled afterwards in one batch, and its
 * paste-burst rule makes an Enter that arrives with the text a newline instead of a submit. Measured with
 * the real binary through this service (2026-10-09): unanswered, resize→input left the text in the
 * composer 0/6 times submitted; answered by the host, 36/36.
 */
const CROSSTERM_LIKE_CLI = `#!${process.execPath}
const {stdin, stdout} = process;
stdin.setRawMode(true);
let waiting = null, held = '', composer = '', lastAt = 0;
const say = line => stdout.write(line + '\\r\\n');
const keys = (text, at) => { for (const ch of text) { if (ch === '\\r') { if (at - lastAt < 8) composer += '\\n'; else { say('SUBMIT:' + JSON.stringify(composer)); composer = ''; } } else composer += ch; lastAt = at; } };
const finish = answered => { clearTimeout(waiting.timer); const ms = Date.now() - waiting.since; waiting = null; say((answered ? 'CPR:ANSWERED:' : 'CPR:TIMEOUT:') + ms); const batch = held; held = ''; keys(batch, Date.now()); };
process.on('SIGWINCH', () => { if (waiting) return; stdout.write('\\x1b[6n'); waiting = {since: Date.now(), timer: setTimeout(() => finish(false), 2000)}; });
stdin.on('data', chunk => {
  const text = chunk.toString('utf8');
  if (waiting) { held += text; const m = /\\x1b\\[\\d+;\\d+R/.exec(held); if (m) { held = held.slice(0, m.index) + held.slice(m.index + m[0].length); finish(true); } return; }
  keys(text.replace(/\\x1b\\[\\d+;\\d+R/g, () => { say('STRAY_CPR'); return ''; }), Date.now());
});
say('READY');
`;

(posix?describe:describe.skip)('a resize right before input (the phone claims its size first)',()=>{
  const dirs:string[]=[];const services:AiTerminalService[]=[];
  afterEach(async()=>{await Promise.all(services.splice(0).map(s=>s.shutdown()));for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
  const req=(r:any)=>({...r,requestId:crypto.randomUUID()});
  for (const [label, cols, rows] of [['grow', 40, 25], ['shrink', 40, 6], ['wider', 60, 10]] as const) {
    test(`${label}: the CLI is answered at once and Enter still submits`,async()=>{
      const dir=mkdtempSync(join(tmpdir(),'agentstoz-cpr-stall-'));dirs.push(dir);
      const cli=join(dir,'cli');writeFileSync(cli,CROSSTERM_LIKE_CLI);chmodSync(cli,0o755);
      const service=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>cli,codexHookTrustSupported:async()=>false});services.push(service);
      const id=(await service.perform(req({operation:'start',targetId:'project-fixture-123',agent:'codex',cols:40,rows:10}))).session!.id;
      let text='',cursor=0;
      const read=async(until:string,ms:number)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await service.perform(req({operation:'read',sessionId:id,after:cursor}));for(const c of r.chunks??[]){text+=c.text;cursor=c.seq;}if(text.includes(until))return true;await Bun.sleep(20);}return false;};
      expect(await read('READY',5000)).toBe(true);
      // Exactly the phone's order: the size claim, then the input with no gap (src/AiTerminalPanel.tsx enqueue).
      await service.perform(req({operation:'resize',sessionId:id,cols,rows}));
      await service.perform(req({operation:'input',sessionId:id,data:'OK-x\r'}));
      // Well inside the CLI's 2 s wait: only a prompt answer gets the Enter there in time.
      expect(await read('SUBMIT:',1500)).toBe(true);
      expect(text).toContain('SUBMIT:"OK-x"');
      expect(text).toMatch(/CPR:ANSWERED:\d+/);
      expect(text).not.toContain('STRAY_CPR');
    });
  }
});

// Clients cut a large batch at 4096 bytes / 7500 JSON characters without regard to escape sequences
// (splitTerminalInput, the LAN page). The filter must read one session's requests as one stream (review 2026-10-09).
describe('a paste marker or a reply cut by the request split',()=>{
  const stream=(parts:string[],state:ViewerReplyFilterState={pasteOpen:false},ambiguousIsReply=false)=>parts.map(p=>stripViewerTerminalReplies(p,state,{ambiguousIsReply})).join('');
  test('a paste end marker cut in two still closes the paste, and the next forwarded reply is removed',()=>{
    for(let length=4080;length<=4095;length++){
      const state:ViewerReplyFilterState={pasteOpen:false};
      const paste='\x1b[200~'+'a'.repeat(length)+'\x1b[201~';
      const parts=splitTerminalInput(paste);
      expect(stream(parts,state)).toBe(paste);
      expect(state.pasteOpen).toBe(false);
      expect(stream(['\x1b[12;40R'],state)).toBe('');
    }
  });
  test('a paste start marker cut in two still opens the paste, and its content is not edited',()=>{
    for(let length=4085;length<=4095;length++){
      const state:ViewerReplyFilterState={pasteOpen:false};
      const paste='x'.repeat(length)+'\x1b[200~keep \x1b[2;3R literal\x1b[201~';
      expect(stream(splitTerminalInput(paste),state)).toBe(paste);
      expect(state.pasteOpen).toBe(false);
    }
  });
  test('a reply cut in two is removed as a whole — neither half reaches the CLI',()=>{
    for(let length=4088;length<=4095;length++){                              // the 4096-byte cut falls inside the reply
      const state:ViewerReplyFilterState={pasteOpen:false};
      const text='y'.repeat(length)+'\x1b[12;40R'+'z';
      const parts=splitTerminalInput(text);
      expect(parts.length).toBe(2);
      expect(stream(parts,state)).toBe('y'.repeat(length)+'z');
      expect(state.held).toBe('');
    }
  });
  test('a short request ending in ESC is the Esc key and is never held',()=>{
    const state:ViewerReplyFilterState={pasteOpen:false};
    expect(stream(['\x1b'],state)).toBe('\x1b');
    expect(stream(['abc\x1b['],state)).toBe('abc\x1b[');
    expect('x'.repeat(VIEWER_SPLIT_PART_MIN_CHARS-2).length).toBeLessThan(VIEWER_SPLIT_PART_MIN_CHARS);
    expect(stream(['x'.repeat(VIEWER_SPLIT_PART_MIN_CHARS-2)+'\x1b'],state)).toEndWith('\x1b');
  });
});

/** Records every read the CLI makes, with a timestamp, and asks CSI 6 n when told to. */
const READ_LOGGER_CLI = `#!${process.execPath}
const {stdin, stdout} = process;
stdin.setRawMode(true);
process.on('SIGWINCH', () => stdout.write('\\x1b[6n'));
stdout.write('READY\\r\\n');
stdin.on('data', chunk => stdout.write('IN' + JSON.stringify(chunk.toString('utf8')) + '@' + Date.now() + '\\r\\n'));
`;

(posix?describe:describe.skip)('the host answer and the Enter keep their place in the byte stream',()=>{
  const dirs:string[]=[];const services:AiTerminalService[]=[];const kills:(()=>void)[]=[];
  afterEach(async()=>{for(const kill of kills.splice(0))kill();await Promise.all(services.splice(0).map(s=>s.shutdown()));for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
  const req=(r:any)=>({...r,requestId:crypto.randomUUID()});
  const cliIn=(dir:string)=>{const cli=join(dir,'cli');writeFileSync(cli,READ_LOGGER_CLI);chmodSync(cli,0o755);return cli;};
  test('a host answer to a query asked while a viewer paste is open is written after the paste, never inside it',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'agentstoz-cpr-paste-'));dirs.push(dir);const cli=cliIn(dir);
    const service=new AiTerminalService({resolveTarget:async()=>({cwd:dir}),executable:()=>cli});services.push(service);
    const id=(await service.perform(req({operation:'start',targetId:'project-fixture-123',agent:'claude',cols:80,rows:24}))).session!.id;
    let text='',cursor=0;
    const read=async(until:RegExp,ms=4000)=>{const end=Date.now()+ms;while(Date.now()<end){const r=await service.perform(req({operation:'read',sessionId:id,after:cursor}));for(const c of r.chunks??[]){text+=c.text;cursor=c.seq;}if(until.test(text))return;await Bun.sleep(20);}throw new Error('missing '+until+' in '+JSON.stringify(text.slice(-400)));};
    await read(/READY/);
    const parts=splitTerminalInput('\x1b[200~'+'a'.repeat(6000)+'\x1b[201~');
    expect(parts.length).toBe(2);
    await service.perform(req({operation:'input',sessionId:id,data:parts[0]}));   // the CLI is now inside the paste
    await service.perform(req({operation:'resize',sessionId:id,cols:90,rows:24})); // it asks CSI 6 n meanwhile
    await read(/\x1b\[6n/);await Bun.sleep(100);
    await service.perform(req({operation:'input',sessionId:id,data:parts[1]}));
    await read(/\\u001b\[\d+;\d+R/);
    const received=[...text.matchAll(/IN("(?:[^"\\]|\\.)*")@\d+/g)].map(m=>JSON.parse(m[1]!) as string).join('');
    const end=received.indexOf('\x1b[201~'), answer=received.search(/\x1b\[\d+;\d+R/);
    expect(end).toBeGreaterThan(0);
    expect(answer).toBeGreaterThan(end);                                     // after the paste, not inside it
    expect(received.slice(received.indexOf('\x1b[200~'),end+6)).toBe('\x1b[200~'+'a'.repeat(6000)+'\x1b[201~');
  });
  test('a stall of the host right after the body still leaves the measured gap before Enter',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'agentstoz-enter-gap-'));dirs.push(dir);const cli=cliIn(dir);
    let out='';const child=(Bun.spawn as any)([cli],{terminal:{cols:40,rows:10,data:(_:unknown,d:Uint8Array)=>{out+=new TextDecoder().decode(d);}}});kills.push(()=>{try{child.kill();}catch{}});
    const until=async(re:RegExp)=>{const end=Date.now()+4000;while(Date.now()<end&&!re.test(out))await Bun.sleep(10);expect(re.test(out)).toBe(true);};
    await until(/READY/);
    // Something else blocks the event loop for 300 ms right after the body is handed to the PTY (spawnSync, big JSON…).
    const stalling={write:(data:string)=>{const n=child.terminal.write(data);if(data!=='\r')queueMicrotask(()=>{const end=performance.now()+300;while(performance.now()<end){}});return n;}};
    await writeAiTerminalInput('codex',stalling,'OK-gap\r');
    await until(/IN"\\r"@\d+/);
    const reads=[...out.matchAll(/IN("(?:[^"\\]|\\.)*")@(\d+)/g)].map(m=>({data:JSON.parse(m[1]!) as string,at:Number(m[2])}));
    const body=reads.find(r=>r.data.includes('OK-gap'))!, enter=reads.find(r=>r.data==='\r')!;
    expect(body.data).toBe('OK-gap');                                        // not merged with the Enter
    expect(enter.at-body.at).toBeGreaterThanOrEqual(100);
  });
});
