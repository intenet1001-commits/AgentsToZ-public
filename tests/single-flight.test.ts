import {expect,test} from 'bun:test';
import {singleFlight} from '../src/singleFlight';

test('slow read probes coalesce timer and manual refresh calls without a backlog',async()=>{
 let release!:(value:number)=>void,calls=0;
 const read=singleFlight(async()=>{calls++;return new Promise<number>(resolve=>{release=resolve})});
 const first=read();const rest=Array.from({length:500},()=>read());
 expect(rest.every(p=>p===first)).toBe(true);
 await Promise.resolve();expect(calls).toBe(1);
 release(42);expect(await first).toBe(42);
 const next=read();await Promise.resolve();expect(calls).toBe(2);release(43);expect(await next).toBe(43);
});

test('rejected probes release their slot and separate resources remain independent',async()=>{
 let calls=0;
 const failed=singleFlight(async()=>{calls++;throw new Error('offline')});
 const healthy=singleFlight(async()=>7);
 await expect(failed()).rejects.toThrow('offline');
 expect(await healthy()).toBe(7);
 await expect(failed()).rejects.toThrow('offline');expect(calls).toBe(2);
});
