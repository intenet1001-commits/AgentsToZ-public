import {expect,test} from 'bun:test';
import {
 WORKROOM_OPEN_SESSION_REFRESH_MS,WORKROOM_OPEN_SESSION_TTL_MS,forgetOpenWorkroomSession,refreshOpenWorkroomSession,openWorkroomSessionToRestore,rememberOpenWorkroomSession,workroomOpenSessionKey,
} from '../src/workroomSessionView';

// S4.2 (w11): the phone remembers which session it had open per Mac, so a reload — or iOS reloading a page whose WebContent
// process it reclaimed — puts the user back in that session. localStorage with a TTL: whether sessionStorage survives a
// reclaim reload is unverified (plan critique 17). The browser side is tests/remote-phone-layout.e2e.mjs (reload-*).

const memory=()=>{const map=new Map<string,string>();return {map,getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>void map.set(k,v),removeItem:(k:string)=>void map.delete(k)};};
const T=Date.parse('2026-10-16T09:00:00Z');

test('remembered per Mac, restored within the TTL', () => {
 const s=memory();
 rememberOpenWorkroomSession(s,'host-a','session-1',T);
 rememberOpenWorkroomSession(s,'host-b','session-2',T);
 expect(openWorkroomSessionToRestore(s,'host-a',T+60_000)).toBe('session-1');
 expect(openWorkroomSessionToRestore(s,'host-b',T+60_000)).toBe('session-2');
 expect(openWorkroomSessionToRestore(s,'host-c',T)).toBeNull();
});

test('older than the TTL is not restored and the record goes', () => {
 const s=memory();
 rememberOpenWorkroomSession(s,'host-a','session-1',T);
 expect(openWorkroomSessionToRestore(s,'host-a',T+WORKROOM_OPEN_SESSION_TTL_MS+1)).toBeNull();
 expect(s.map.has(workroomOpenSessionKey('host-a'))).toBe(false);
 // Exactly at the edge it still counts; the TTL is 30 minutes.
 rememberOpenWorkroomSession(s,'host-a','session-1',T);
 expect(openWorkroomSessionToRestore(s,'host-a',T+WORKROOM_OPEN_SESSION_TTL_MS)).toBe('session-1');
 expect(WORKROOM_OPEN_SESSION_TTL_MS).toBe(30*60_000);
});

test('closing forgets it; a record from the future, a corrupt one or another shape is dropped', () => {
 const s=memory();
 rememberOpenWorkroomSession(s,'host-a','session-1',T);forgetOpenWorkroomSession(s,'host-a');
 expect(openWorkroomSessionToRestore(s,'host-a',T)).toBeNull();
 for(const raw of ['{','null','[]','{"id":3,"at":1}',JSON.stringify({id:'s',at:T+10*60_000}),JSON.stringify({id:'',at:T})]){
  s.map.set(workroomOpenSessionKey('host-a'),raw);
  expect(openWorkroomSessionToRestore(s,'host-a',T)).toBeNull();
  expect(s.map.has(workroomOpenSessionKey('host-a'))).toBe(false);
 }
});

test('storage that throws (blocked site data) is no record and never throws', () => {
 const broken={getItem:()=>{throw new Error('SecurityError');},setItem:()=>{throw new Error('QuotaExceeded');},removeItem:()=>{throw new Error('SecurityError');}};
 expect(()=>rememberOpenWorkroomSession(broken,'host-a','session-1',T)).not.toThrow();
 expect(()=>forgetOpenWorkroomSession(broken,'host-a')).not.toThrow();
 expect(openWorkroomSessionToRestore(broken,'host-a',T)).toBeNull();
 expect(openWorkroomSessionToRestore(null,'host-a',T)).toBeNull();
});

test('kept fresh while the view stays open: the TTL runs from the last watch, not from opening (w11 review)', () => {
 const s=memory();
 rememberOpenWorkroomSession(s,'host-a','session-1',T);
 // A long run watched in the foreground: reads keep refreshing the record, at most once a minute.
 let now=T;let writes=0;
 for(let minute=0;minute<45;minute++){for(let read=0;read<10;read++){now+=6_000;if(refreshOpenWorkroomSession(s,'host-a','session-1',now))writes++;}}
 expect(writes).toBeLessThanOrEqual(46);expect(writes).toBeGreaterThanOrEqual(44);
 // 45 minutes after opening, a reload still reopens it.
 expect(openWorkroomSessionToRestore(s,'host-a',now+1_000)).toBe('session-1');
 // Within a minute of the last write nothing is written; a different session or a missing record is written at once.
 expect(refreshOpenWorkroomSession(s,'host-a','session-1',now+WORKROOM_OPEN_SESSION_REFRESH_MS-1)).toBe(false);
 expect(refreshOpenWorkroomSession(s,'host-a','session-2',now+1)).toBe(true);
 expect(openWorkroomSessionToRestore(s,'host-a',now+2)).toBe('session-2');
 forgetOpenWorkroomSession(s,'host-a');
 expect(refreshOpenWorkroomSession(s,'host-a','session-2',now+3)).toBe(true);
 expect(refreshOpenWorkroomSession(null,'host-a','session-2',now+3)).toBe(false);
});
