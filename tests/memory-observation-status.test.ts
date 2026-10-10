import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {existsSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemorySaveStore} from '../src/memorySaveStore';
import {saveDigest,type MemorySaveSource} from '../src/memorySaveContract';
import {getMemoryObservationStatus,readMemoryObservationSummary} from '../src/memoryObservationStatus';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),'observation-status-'));roots.push(root);return {root,path:join(root,'memory.sqlite')};}
const source=(i:number,extra:Partial<MemorySaveSource>={}):MemorySaveSource=>({agent:'codex',instanceId:'instance',sessionId:'session',turnId:`turn-${i}`,startByte:i*100,endByte:i*100+50,memoryId:'memory-a',policyEpoch:1,sourceDigest:saveDigest(i),completedAt:1,coverageKind:'complete-turn',...extra});

test('status reads do not create a database or alter durable observations, and survive reopening',()=>{
 const {path}=fixture();expect(readMemoryObservationSummary(path,'memory-a')).toEqual({completedTurns:0,hasMore:false});expect(existsSync(path)).toBe(false);
 const store=new MemorySaveStore(path);store.observe(source(0));store.observe(source(1,{memoryId:'memory-b'}));store.observe(source(2,{policyEpoch:2}));store.observe(source(3,{coverageKind:'fragment'}));
 const before=readFileSync(path);expect(readMemoryObservationSummary(path,'memory-a')).toEqual({completedTurns:1,hasMore:false});
 expect(readMemoryObservationSummary(path,'memory-b').completedTurns).toBe(1);expect(readFileSync(path)).toEqual(before);
 const pending=store.pending('memory-a',1).items;store.reserve('memory-a',1,[pending[0]!.sourceKey]);
 expect(readMemoryObservationSummary(path,'memory-a').completedTurns).toBe(0);expect(store.page().items[0]?.phase).toBe('prepared');
});

test('status bounds its indexed pending window and does not count partial fragments as completed conversations',()=>{
 const {path}=fixture();const store=new MemorySaveStore(path);
 for(let start=0;start<20000;start+=128)store.observeBatch(Array.from({length:Math.min(128,20000-start)},(_,i)=>source(start+i,{coverageKind:start+i<128?'fragment':'complete-turn'})));
 expect(readMemoryObservationSummary(path,'memory-a')).toEqual({completedTurns:0,hasMore:true});
 const db=new Database(path);const plan=db.query('EXPLAIN QUERY PLAN SELECT coverageKind FROM save_sources WHERE memoryId=? AND policyEpoch=1 AND saveId IS NULL ORDER BY sequence LIMIT 129').all('memory-a');db.close();
 expect(JSON.stringify(plan)).toContain('sources_pending');expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE');
});

test('corrupt, future, and symlink databases are unavailable without replacement or creation',()=>{
 const {root,path}=fixture();writeFileSync(path,'invalid');expect(()=>readMemoryObservationSummary(path,'memory-a')).toThrow();expect(readFileSync(path,'utf8')).toBe('invalid');rmSync(path);
 const external=join(root,'external');writeFileSync(external,'preserve');symlinkSync(external,path);expect(()=>readMemoryObservationSummary(path,'memory-a')).toThrow();expect(readFileSync(external,'utf8')).toBe('preserve');rmSync(path);
 const db=new Database(path);db.run('PRAGMA user_version=99');db.close();const bytes=readFileSync(path);expect(()=>readMemoryObservationSummary(path,'memory-a')).toThrow();expect(readFileSync(path)).toEqual(bytes);
});

test('status revalidates current memory ownership and shutdown without leaking paths or making save claims',async()=>{
 let enabled=true,valid=true,reads=0;
 const deps={enabled:()=>enabled,resolve:async()=>({memoryId:'memory-a',validateRegistration:async()=>valid}),read:(id:string)=>{expect(id).toBe('memory-a');reads++;return {completedTurns:2,hasMore:false};}};
 expect(await getMemoryObservationStatus('target-a',deps)).toEqual({version:1,targetId:'target-a',state:'available',completedTurns:2,hasMore:false,conversationMemory:'not-connected'});
 valid=false;expect((await getMemoryObservationStatus('target-a',deps)).state).toBe('unavailable');
 enabled=false;expect((await getMemoryObservationStatus('target-a',deps)).state).toBe('inactive');expect(reads).toBe(2);
 enabled=true;deps.resolve=async()=>{throw new Error('/private/credential secret');};
 const failure=await getMemoryObservationStatus('target-a',deps);expect(failure.state).toBe('unavailable');expect(JSON.stringify(failure)).not.toContain('secret');
 expect((await getMemoryObservationStatus('target-a',{...deps,resolve:async()=>null})).state).toBe('uninitialized');
 deps.resolve=async()=>({memoryId:'memory-a',validateRegistration:async()=>{enabled=false;return true;}});
 expect((await getMemoryObservationStatus('target-a',deps)).state).toBe('inactive');
});
