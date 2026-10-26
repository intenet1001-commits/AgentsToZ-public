import {describe,expect,test} from 'bun:test';
import {CONTROL_MEMORY_BODY_LIMIT,CONTROL_MEMORY_LIST_LIMIT,listControlMemoryEntries,readControlMemoryEntry} from '../src/controlMemoryEntries';
import {ControlProfileError,type ControlProfileStatus} from '../src/controlProfileContract';
import {parseProjectMemoryEntries} from '../src/projectMemoryRecall';

// UX audit 2026-10-25: 아젠투지 설정 said operating memory was managed there but never showed a saved entry.
const status={state:'ready',revision:'revision-1'} as ControlProfileStatus;
const ready=(document:string)=>({read:()=>({status,snapshot:{document}})});
const notReady=(message='먼저 AgentsToZ 프로필을 준비하세요.')=>({read:()=>{throw new ControlProfileError('CONTROL_PROFILE_NOT_READY',message);}});
const entry=(title:string,id:string,body:string)=>`### ${title}\n<!-- memory-entry-id:${id} -->\n\n${body}\n`;
const id=(n:number)=>n.toString(16).padStart(24,'0');

describe('saved operating memory for 아젠투지 설정',()=>{
  test('titles come newest first without bodies; one body is read by its entry id',()=>{
    const document=`# Project Core Memory\n\n## Key Decisions\n\n<!-- Append durable decisions -->\n\n${entry('처음 결정',id(1),'처음 본문')}\n## AgentsToZ 운영 결정\n\n${entry('나중 결정',id(2),'나중 본문\n둘째 줄')}`;
    const list=listControlMemoryEntries(ready(document));
    expect(list).toEqual({ready:true,revision:'revision-1',total:2,entries:[
      {entryId:id(2),section:'AgentsToZ 운영 결정',title:'나중 결정'},
      {entryId:id(1),section:'Key Decisions',title:'처음 결정'},
    ]});
    expect(JSON.stringify(list)).not.toContain('본문');
    expect(readControlMemoryEntry(ready(document),id(2))).toEqual({entryId:id(2),section:'AgentsToZ 운영 결정',title:'나중 결정',revision:'revision-1',body:'나중 본문\n둘째 줄',truncated:false});
  });

  test('a fresh memory has no entries; legacy headings without a marker still list and open',()=>{
    expect(listControlMemoryEntries(ready('# Project Core Memory\n\n## Key Decisions\n\n<!-- Append -->\n'))).toMatchObject({ready:true,total:0,entries:[]});
    const legacy='## Key Decisions\n\n### 손으로 쓴 결정\n본문\n';
    const [only]=listControlMemoryEntries(ready(legacy)).entries;
    expect(only!.entryId).toBe(parseProjectMemoryEntries(legacy)[0]!.entryId);
    expect(readControlMemoryEntry(ready(legacy),only!.entryId).body).toBe('본문');
  });

  test('the list and a body are bounded',()=>{
    const many=Array.from({length:CONTROL_MEMORY_LIST_LIMIT+5},(_,n)=>entry(`결정 ${n}`,id(n+1),'짧은 본문')).join('\n');
    const list=listControlMemoryEntries(ready(`## Key Decisions\n\n${many}`));
    expect(list.total).toBe(CONTROL_MEMORY_LIST_LIMIT+5);
    expect(list.entries.length).toBe(CONTROL_MEMORY_LIST_LIMIT);
    expect(list.entries[0]!.title).toBe(`결정 ${CONTROL_MEMORY_LIST_LIMIT+4}`);
    const long='가'.repeat(CONTROL_MEMORY_BODY_LIMIT+10)+'😀';
    const read=readControlMemoryEntry(ready(`## Key Decisions\n\n${entry('긴 결정',id(7),long)}`),id(7));
    expect(read.truncated).toBe(true);
    expect(Array.from(read.body).length).toBe(CONTROL_MEMORY_BODY_LIMIT);
    const longTitle=listControlMemoryEntries(ready(`## Key Decisions\n\n${entry('제'.repeat(500),id(8),'본문')}`)).entries[0]!.title;
    expect(Array.from(longTitle).length).toBe(200);
  });

  test('a profile that is not ready answers with its problem instead of throwing',()=>{
    expect(listControlMemoryEntries(notReady('연결 확인이 필요합니다.'))).toEqual({ready:false,problem:'연결 확인이 필요합니다.',total:0,entries:[]});
    expect(()=>readControlMemoryEntry(notReady(),id(1))).toThrow('먼저 AgentsToZ 프로필을 준비하세요.');
    const other={read:()=>{throw new Error('unexpected');}};
    expect(()=>listControlMemoryEntries(other)).toThrow('unexpected');
  });

  test('an entry id must be the stored 24-hex form, and a vanished entry says to reload',()=>{
    const document=`## Key Decisions\n\n${entry('결정',id(1),'본문')}`;
    for(const bad of [undefined,'','../etc','A'.repeat(24),id(1)+'0'])
      expect(()=>readControlMemoryEntry(ready(document),bad)).toThrow(expect.objectContaining({code:'CONTROL_MEMORY_ENTRY_INVALID',status:400}));
    expect(()=>readControlMemoryEntry(ready(document),id(9))).toThrow(expect.objectContaining({code:'CONTROL_MEMORY_ENTRY_MISSING',status:404}));
  });
});
