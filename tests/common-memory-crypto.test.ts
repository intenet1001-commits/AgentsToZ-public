import {expect,test} from 'bun:test';
import {createHash,webcrypto} from 'node:crypto';
import {commonMemoryUuid,commonMemoryDigest} from '../src/commonMemoryCrypto';
test('LAN WebKit hashes match host SHA-256 and retain cryptographically random UUIDs',async()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
 try{
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:webcrypto.getRandomValues.bind(webcrypto)}});
  for(const text of ['', 'abc', '공통기억의 목표 · 🚙', 'source'.repeat(20_000)])expect(await commonMemoryDigest(text)).toBe(createHash('sha256').update(text).digest('hex'));
  const ids=Array.from({length:100},()=>commonMemoryUuid());expect(new Set(ids).size).toBe(100);
  expect(ids.every(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))).toBe(true);
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{}});expect(()=>commonMemoryUuid()).toThrow('안전한');
 }finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);}
});
