import {afterEach, expect, test} from 'bun:test';
import {confirmAction} from '../src/confirmAction';

const original=Object.getOwnPropertyDescriptor(globalThis,'window');
afterEach(()=>{if(original)Object.defineProperty(globalThis,'window',original);else Reflect.deleteProperty(globalThis,'window');});
const prompt=(confirm:()=>unknown)=>Object.defineProperty(globalThis,'window',{configurable:true,value:{confirm}});

test('both browser booleans and native promises require an explicit true response',async()=>{
 for(const value of [true,false,undefined,null,'true',1,{}]){
  prompt(()=>value);expect(await confirmAction('change')).toBe(value===true);
  prompt(()=>Promise.resolve(value));expect(await confirmAction('change')).toBe(value===true);
 }
});

test('pending native confirmation blocks concurrent prompts and resolves only after the reply',async()=>{
 let reply!:(value:boolean)=>void,calls=0,settled=false;
 prompt(()=>{calls++;return new Promise<boolean>(resolve=>{reply=resolve;});});
 const first=confirmAction('restart').then(value=>{settled=true;return value;});
 await Promise.resolve();expect(settled).toBe(false);
 expect(await confirmAction('delete')).toBe(false);expect(calls).toBe(1);
 reply(false);expect(await first).toBe(false);
 prompt(()=>true);expect(await confirmAction('next action')).toBe(true);
});

test('missing or failing dialog never authorizes a change and does not leave the prompt locked',async()=>{
 Reflect.deleteProperty(globalThis,'window');expect(await confirmAction('missing')).toBe(false);
 prompt(()=>{throw Error('native bridge unavailable');});expect(await confirmAction('throw')).toBe(false);
 prompt(()=>Promise.reject(Error('native dialog failed')));expect(await confirmAction('reject')).toBe(false);
 prompt(()=>true);expect(await confirmAction('retry')).toBe(true);
});
