import {describe,expect,test} from 'bun:test';
import {Terminal} from '@xterm/headless';
import {
  AI_TERMINAL_PAGE_MAX_BYTES,
  AI_TERMINAL_PAGE_MAX_CHUNK_CHARS,
  AI_TERMINAL_PAGE_MAX_CHUNKS,
  AI_TERMINAL_SNAPSHOT_MAX_PAGES,
  AiTerminalScreen,
  packSnapshotPages,
} from '../src/aiTerminalScreen';
import {aiTerminalSnapshotUnsupported} from '../src/aiTerminalProtocol';

const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
const drain=(terminal:Terminal)=>new Promise<void>(resolve=>terminal.write('',resolve));

describe('late Workroom screen snapshots',()=>{
  test('packs Unicode safely inside the unchanged v1 wire limits',()=>{
    const text='색상\x1b[31m🐳😀\x1b[0m'.repeat(180);
    const pages=packSnapshotPages(text,999_999,8)!;
    expect(pages.flat().join('')).toBe(text);
    for(const page of pages){
      expect(page.length).toBeLessThanOrEqual(AI_TERMINAL_PAGE_MAX_CHUNKS);
      expect(page.every(chunk=>chunk.length<=AI_TERMINAL_PAGE_MAX_CHUNK_CHARS)).toBe(true);
      expect(bytes(page.map((chunk,index)=>({seq:999_990+index,text:chunk})))).toBeLessThan(AI_TERMINAL_PAGE_MAX_BYTES+200);
    }
  });

  test('restores the current screen in at most two reads and resumes at the live cursor',async()=>{
    const screen=new AiTerminalScreen(42,8);
    const retained:{seq:number;text:string}[]=[];
    for(let seq=1;seq<=180;seq++){
      const label=String(seq).padStart(3,'0');
      const text=`\x1b[H\x1b[2JFRAME_${label}\r\n${'history '.repeat(30)}\r\nCURRENT_${label}`;
      retained.push({seq,text});screen.write(text,seq);
    }
    const client=new Terminal({cols:42,rows:8,scrollback:20,allowProposedApi:true});
    let page=await screen.snapshotPage(0,retained,180);
    let reads=0,cursor=0;
    while(page){
      reads++;client.write(page.chunks.map(chunk=>chunk.text).join(''));await drain(client);
      cursor=page.nextCursor;
      if(!page.hasMore||reads===AI_TERMINAL_SNAPSHOT_MAX_PAGES)break;
      page=await screen.snapshotPage(cursor,retained,180);
    }
    const visible=Array.from({length:client.rows},(_,row)=>client.buffer.active.getLine(client.buffer.active.baseY+row)?.translateToString(true)??'').join('\n');
    expect(reads).toBeLessThanOrEqual(AI_TERMINAL_SNAPSHOT_MAX_PAGES);
    expect(cursor).toBe(180);
    expect(visible).toContain('CURRENT_180');
    expect(visible).not.toContain('FRAME_001');
    screen.dispose();client.dispose();
  });

  test('recognizes both encrypted-relay and legacy LAN refusal shapes',()=>{
    expect(aiTerminalSnapshotUnsupported(Object.assign(new Error('generic'),{code:'TERMINAL_REQUEST_INVALID'}))).toBe(true);
    expect(aiTerminalSnapshotUnsupported(new Error('허용되지 않은 터미널 요청입니다.'))).toBe(true);
    expect(aiTerminalSnapshotUnsupported(new Error('터미널 요청 형식이 올바르지 않습니다.'))).toBe(true);
    expect(aiTerminalSnapshotUnsupported(new Error('연결이 끊겼습니다.'))).toBe(false);
  });
});

describe('screen facts an orchestrating AI reads',()=>{
  test('input modes and plain rows reflect everything written before the read',async()=>{
    const screen=new AiTerminalScreen(30,5);
    expect(await screen.settledModes()).toEqual({bracketedPaste:false,applicationCursorKeys:false});
    screen.write('\x1b[?2004h\x1b[?1h\x1b[1mTrust this folder?\x1b[0m\r\n  1. Yes\r\n  2. No',3);
    expect(await screen.settledModes()).toEqual({bracketedPaste:true,applicationCursorKeys:true});
    expect(screen.bracketedPasteMode).toBe(true);
    expect(screen.applicationCursorKeysMode).toBe(true);
    expect(await screen.plainRows()).toEqual({rows:['Trust this folder?','  1. Yes','  2. No','',''],cursorRow:2,cursorCol:7,alternate:false});
    screen.write('\x1b[?2004l\x1b[?1l\x1b[?1049h\x1b[HFULL',4);
    expect(await screen.settledModes()).toEqual({bracketedPaste:false,applicationCursorKeys:false});
    expect(await screen.plainRows()).toMatchObject({rows:['FULL','','','',''],alternate:true});
    screen.dispose();
    expect(await screen.plainRows()).toBeNull();
    expect(await screen.settledModes()).toEqual({bracketedPaste:false,applicationCursorKeys:false});
    expect(screen.bracketedPasteMode).toBe(false);
  });
});
