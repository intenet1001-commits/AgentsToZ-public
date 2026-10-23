import {expect,test} from 'bun:test';
import {mergeUserMemoryTimeline,summariseUserMemoryTimeline,type TimelineInstruction,type TimelineItem,type TimelineOutcome} from '../src/userMemoryTimeline';

const at=(minute:number)=>new Date(Date.UTC(2026,9,22,0,minute)).toISOString();
const say=(id:string,minute:number,over:Partial<TimelineInstruction>={}):TimelineInstruction=>
  ({id,recordedAt:at(minute),agent:'claude',memoryId:'m1',projectId:'p1',projectName:'프로젝트',deviceId:'d1',deviceName:'1호',text:`지시 ${id}`,...over});
const done=(hash:string,minute:number,over:Partial<TimelineOutcome>={}):TimelineOutcome=>
  ({entryHash:hash,memoryId:'m1',recordedAt:at(minute),agent:'claude',projectName:'프로젝트',deviceId:'d1',deviceName:'1호',summary:`결과 ${hash}`,...over});

const instructionIds=(items:readonly TimelineItem[]):string[]=>items.flatMap(i=>i.kind==='outcome'?[]:i.instructions.map(x=>x.id));
const outcomeHashes=(items:readonly TimelineItem[]):string[]=>items.flatMap(i=>i.kind==='instructions'?[]:[i.outcome.entryHash]);

test('one journal row bundles every instruction since the previous one — the relation is 1:N, not 1:1',()=>{
  const items=mergeUserMemoryTimeline({
    instructions:[say('a',11),say('b',13),say('c',15),say('d',21),say('e',22)],
    outcomes:[done('j1',10),done('j2',20),done('j3',30)],
  });
  const sessions=items.filter(i=>i.kind==='session');
  expect(sessions.map(s=>s.kind==='session'?s.instructions.map(x=>x.id):[])).toEqual([['d','e'],['a','b','c']]);
  // 1:1로 짝지었다면 세션당 한 개씩만 붙어 나머지는 전부 미짝이 된다(실측 4%의 원인).
  expect(summariseUserMemoryTimeline(items).pairedInstructions).toBe(5);
});

test('the window closes on its own edge, so an instruction at the exact journal time belongs to one bundle only',()=>{
  const items=mergeUserMemoryTimeline({instructions:[say('edge',20)],outcomes:[done('j1',10),done('j2',20),done('j3',30)]});
  expect(instructionIds(items)).toEqual(['edge']);
  const owner=items.find(i=>i.kind==='session');
  expect(owner?.kind==='session'&&owner.outcome.entryHash).toBe('j2');
});

test('the first journal of a memory does not claim the instructions before it',()=>{
  const items=mergeUserMemoryTimeline({instructions:[say('old',5)],outcomes:[done('j1',10)]});
  const unpaired=items.find(i=>i.kind==='instructions');
  expect(unpaired?.kind==='instructions'&&unpaired.reason).toBe('before-first-record');
  expect(items.some(i=>i.kind==='outcome'&&i.outcome.entryHash==='j1')).toBe(true);
});

test('each unpaired instruction carries the reason it has no result',()=>{
  const reason=(instructions:TimelineInstruction[],outcomes:TimelineOutcome[]):string|undefined=>{
    const found=mergeUserMemoryTimeline({instructions,outcomes}).find(i=>i.kind==='instructions');
    return found?.kind==='instructions'?found.reason:undefined;
  };
  expect(reason([say('later',25)],[done('j1',10),done('j2',20)])).toBe('in-progress');
  expect(reason([say('lonely',5)],[])).toBe('no-record');
  expect(reason([say('free',5,{memoryId:null})],[])).toBe('no-memory');
  expect(reason([say('broken',5,{recordedAt:'언제인지 모름'})],[])).toBe('unknown-time');
});

test('nothing is ever dropped: every instruction and every outcome appears exactly once',()=>{
  const instructions=[say('a',11),say('b',20),say('c',31),say('d',5,{memoryId:null}),say('e',7,{memoryId:'m2'}),say('f',9,{recordedAt:'x'})];
  const outcomes=[done('j1',10),done('j2',30),done('k1',8,{memoryId:'m3'}),done('k2',12,{memoryId:'m3'})];
  const items=mergeUserMemoryTimeline({instructions,outcomes});
  expect(instructionIds(items).sort()).toEqual(['a','b','c','d','e','f']);
  expect(outcomeHashes(items).sort()).toEqual(['j1','j2','k1','k2']);
});

test('a bundle whose instructions came from another Mac says so instead of claiming one session',()=>{
  const items=mergeUserMemoryTimeline({instructions:[say('mine',12),say('theirs',13,{deviceId:'d2',deviceName:'3호'})],outcomes:[done('j1',10),done('j2',20)]});
  const session=items.find(i=>i.kind==='session');
  expect(session?.kind==='session'&&session.devicesDiffer).toBe(true);
});

test('newest first, and equal times keep a stable order',()=>{
  const items=mergeUserMemoryTimeline({instructions:[],outcomes:[done('b',10),done('a',10),done('c',40)]});
  expect(outcomeHashes(items)).toEqual(['c','a','b']);
  expect(outcomeHashes(mergeUserMemoryTimeline({instructions:[],outcomes:[done('a',10),done('b',10),done('c',40)]}))).toEqual(['c','a','b']);
});

test('the caller’s arrays are not mutated',()=>{
  const instructions=[say('b',13),say('a',11)],outcomes=[done('j2',20),done('j1',10)];
  mergeUserMemoryTimeline({instructions,outcomes});
  expect(instructions.map(i=>i.id)).toEqual(['b','a']);
  expect(outcomes.map(o=>o.entryHash)).toEqual(['j2','j1']);
});

test('the summary counts pairs, not two totals that read as a ratio',()=>{
  const items=mergeUserMemoryTimeline({instructions:[say('a',11),say('b',12),say('c',99)],outcomes:[done('j1',10),done('j2',20),done('j3',30)]});
  expect(summariseUserMemoryTimeline(items)).toEqual({sessions:1,pairedInstructions:2,unpairedInstructions:1,outcomesWithoutInstructions:2});
});

test('equal-time outcome windows choose the same result regardless of input ordering',()=>{
  const a=done('a',20),b=done('b',20),first=done('first',10),instructions=[say('request',15)];
  const owner=(outcomes:TimelineOutcome[])=>mergeUserMemoryTimeline({instructions,outcomes}).find(item=>item.kind==='session');
  expect(owner([first,a,b])).toEqual(owner([b,first,a]));
});
