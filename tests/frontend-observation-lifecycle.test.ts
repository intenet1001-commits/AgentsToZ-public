import {expect,test} from 'bun:test';
import {startPortLogPolling,PORT_LOG_LINE_LIMIT,PORT_LOG_RETAINED_BYTES,type PortLogRead} from '../src/portLogPolling';
import {retainAgentRuntimeProjection,pruneAgentRuntimeProjections,AGENT_RUNTIME_PROJECTION_CACHE_LIMIT,AGENT_RUNTIME_PROJECTION_CACHE_BYTES,estimatedAgentRuntimeProjectionBytes} from '../src/agentRuntimeProjectionCache';
import {emptyAgentTaskProjection,type AgentTaskProjection} from '../src/agentRuntimeState';

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function logs(){
  const reads:{id:string;offset:number;signal:AbortSignal;resolve:(data:PortLogRead)=>void}[]=[];
  const timers=new Set<()=>void>();const frames:string[][]=[];
  const start=(id:string)=>startPortLogPolling({portId:id,
    read:(id,offset,signal)=>new Promise(resolve=>reads.push({id,offset,signal,resolve})),
    onLines:lines=>frames.push(lines),onLoading:()=>{},
    schedule:callback=>{timers.add(callback);return()=>{timers.delete(callback);};},
  });
  const tick=()=>{const callback=timers.values().next().value;if(callback){timers.delete(callback);callback();}};
  return {reads,timers,frames,start,tick};
}
const data=(content:string,size=content.length):PortLogRead=>({exists:true,content,size});

test('closing before initial response never publishes data or creates a viewer timer',async()=>{
  const fixture=logs();const close=fixture.start('A');close();
  expect(fixture.reads[0]!.signal.aborted).toBeTrue();
  fixture.reads[0]!.resolve(data('late A'));await flush();
  expect(fixture.frames).toEqual([]);expect(fixture.timers.size).toBe(0);
});
test('reverse completion of replaced viewers cannot overwrite the current viewer or orphan a timer',async()=>{
  const fixture=logs();const closeA=fixture.start('A');closeA();const closeB=fixture.start('B');
  fixture.reads[1]!.resolve(data('B'));await flush();
  fixture.reads[0]!.resolve(data('A'));await flush();
  expect(fixture.frames).toEqual([['B']]);expect(fixture.timers.size).toBe(1);
  closeB();expect(fixture.timers.size).toBe(0);
});
test('unmount or visibility cleanup fences an in-flight poll, and a new viewer starts cleanly',async()=>{
  const fixture=logs();const stop=fixture.start('A');fixture.reads[0]!.resolve(data('first',10));await flush();
  fixture.tick();expect(fixture.reads[1]!.offset).toBe(10);stop();
  fixture.reads[1]!.resolve(data('late',20));await flush();
  expect(fixture.frames).toEqual([['first']]);expect(fixture.timers.size).toBe(0);
  const stopAgain=fixture.start('A');expect(fixture.reads[2]!.offset).toBe(0);
  fixture.reads[2]!.resolve(data('resumed',30));await flush();
  expect(fixture.frames.at(-1)).toEqual(['resumed']);stopAgain();
});
test('log rotation and newline-only deltas advance isolated cursors and retain at most 500 lines',async()=>{
  const fixture=logs();const stop=fixture.start('A');
  fixture.reads[0]!.resolve(data(Array.from({length:800},(_,i)=>`line${i}`).join('\n'),10000));await flush();
  expect(fixture.frames.at(-1)?.length).toBe(PORT_LOG_LINE_LIMIT);
  fixture.tick();fixture.reads[1]!.resolve(data('\n',10001));await flush();
  fixture.tick();expect(fixture.reads[2]!.offset).toBe(10001);
  fixture.reads[2]!.resolve(data('rotated',7));await flush();expect(fixture.reads[3]!.offset).toBe(0);
  fixture.reads[3]!.resolve(data('fresh',5));await flush();expect(fixture.frames.at(-1)).toEqual(['fresh']);stop();
});
test('projection retention stays bounded, protects the active task, and treats revisits as recent',()=>{
  let cache:ReadonlyMap<string,AgentTaskProjection>=new Map();
  for(let i=0;i<30;i++)cache=retainAgentRuntimeProjection(cache,String(i),{...emptyAgentTaskProjection(),taskId:String(i),lastSeq:i},'0');
  expect(cache.size).toBe(AGENT_RUNTIME_PROJECTION_CACHE_LIMIT);expect(cache.has('0')).toBeTrue();expect(cache.has('1')).toBeFalse();
  cache=retainAgentRuntimeProjection(cache,'21',cache.get('21')!,'21');
  cache=retainAgentRuntimeProjection(cache,'30',emptyAgentTaskProjection(),'21');
  expect(cache.has('21')).toBeTrue();expect(cache.has('0')).toBeFalse();
  // The same fallback used by the panel replays an evicted task's durable history.
  expect((cache.get('1')??emptyAgentTaskProjection()).lastSeq).toBe(0);
  cache=pruneAgentRuntimeProjections(cache,new Set(['30']),'21');
  expect([...cache.keys()]).toEqual(['21','30']);
});

test('repeated large log lines stay within the retained text budget without dropping the read cursor',async()=>{
  const fixture=logs();const stop=fixture.start('large');
  const line='한'.repeat(128*1024);let size=0;
  for(let i=0;i<20;i++){
    size+=line.length*3;
    fixture.reads[i]!.resolve(data(line,size));await flush();
    const lines=fixture.frames.at(-1)!;
    expect(lines.reduce((bytes,value)=>bytes+value.length*2+32,0)).toBeLessThanOrEqual(PORT_LOG_RETAINED_BYTES);
    expect(lines.length).toBeLessThanOrEqual(PORT_LOG_LINE_LIMIT);
    fixture.tick();expect(fixture.reads[i+1]!.offset).toBe(size);
  }
  stop();fixture.reads.at(-1)!.resolve(data('late',size+4));await flush();
});

test('large event payloads evict inactive projections under the byte budget while protecting the active task',()=>{
  const projection=(id:string,count:number):AgentTaskProjection=>({
    ...emptyAgentTaskProjection(),taskId:id,lastSeq:count,
    events:Array.from({length:count},(_,index)=>({
      protocolVersion:'agentstoz-tasks-v2',taskId:id,seq:index+1,
      occurredAt:'2026-09-07T00:00:00.000Z',type:'task.progress',
      payload:{summary:'큰'.repeat(20*1024),phase:null},
    })),
  });
  let cache:ReadonlyMap<string,AgentTaskProjection>=new Map();
  for(let i=0;i<20;i++){
    cache=retainAgentRuntimeProjection(cache,String(i),projection(String(i),50),'0');
    expect([...cache.values()].reduce((bytes,value)=>bytes+estimatedAgentRuntimeProjectionBytes(value),0)).toBeLessThanOrEqual(AGENT_RUNTIME_PROJECTION_CACHE_BYTES);
    expect(cache.has('0')).toBeTrue();
  }
  expect(cache.size).toBeLessThan(AGENT_RUNTIME_PROJECTION_CACHE_LIMIT);
  const huge=projection('active',500);
  expect(estimatedAgentRuntimeProjectionBytes(huge)).toBeGreaterThan(AGENT_RUNTIME_PROJECTION_CACHE_BYTES);
  cache=retainAgentRuntimeProjection(cache,'active',huge,'active');
  expect([...cache.keys()]).toEqual(['active']);
  cache=retainAgentRuntimeProjection(cache,'inactive',projection('inactive',1),'active');
  expect([...cache.keys()]).toEqual(['active']);
});
