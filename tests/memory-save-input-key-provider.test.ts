import {expect,test} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {readMemorySaveInputKey,memoryInputKeyAccount,MEMORY_INPUT_KEYCHAIN_SERVICE,type MemoryInputKeyRunner} from '../src/memorySaveInputKeyProvider';
import {WHAT_I_SAID_KEYCHAIN_SERVICE} from '../src/whatISaidKeyProvider';

test('dedicated read-only lookup binds a stable installation account and clears its output buffer',async()=>{
 const key=randomBytes(32),stdout=Buffer.from(key.toString('base64')+'\n');let calls=0;
 const runner:MemoryInputKeyRunner=async(command,args)=>{calls++;expect(command).toBe('/usr/bin/security');expect(args).toEqual(['find-generic-password','-a',memoryInputKeyAccount('installation-one'),'-s',MEMORY_INPUT_KEYCHAIN_SERVICE,'-w']);expect(args.join(' ')).not.toContain(key.toString('base64'));return {status:0,stdout};};
 const loaded=await readMemorySaveInputKey({installationId:'installation-one',platform:'darwin',runner});expect(loaded).toEqual(key);expect(stdout.every(v=>v===0)).toBe(true);expect(calls).toBe(1);loaded.fill(0);key.fill(0);
 expect(MEMORY_INPUT_KEYCHAIN_SERVICE).not.toBe(WHAT_I_SAID_KEYCHAIN_SERVICE);
 expect(memoryInputKeyAccount('installation-one')).toBe(memoryInputKeyAccount('installation-one'));expect(memoryInputKeyAccount('installation-two')).not.toBe(memoryInputKeyAccount('installation-one'));
});

test('missing and locked keychains never generate, retry, or fall back to another key',async()=>{
 for(const status of [44,51,1,null]){let calls=0;const stdout=Buffer.from('private diagnostic fixture');
  await expect(readMemorySaveInputKey({installationId:'installation',platform:'darwin',runner:async()=>{calls++;return {status,stdout};}})).rejects.toThrow(status===44?'MISSING':'UNAVAILABLE');
  expect(calls).toBe(1);expect(stdout.every(v=>v===0)).toBe(true);
 }
});

test('noncanonical keys and oversized output fail without revealing or retaining command output',async()=>{
 for(const text of ['', ' '+Buffer.alloc(32).toString('base64'),Buffer.alloc(31).toString('base64'),'not-a-key', 'x'.repeat(257)]){const stdout=Buffer.from(text);
  await expect(readMemorySaveInputKey({installationId:'installation',platform:'darwin',runner:async()=>({status:0,stdout})})).rejects.toThrow(text.length>256?'UNAVAILABLE':'MALFORMED');expect(stdout.every(v=>v===0)).toBe(true);
 }
});

test('unsupported platforms and invalid installation identities never invoke credential commands',async()=>{
 let calls=0;const runner:MemoryInputKeyRunner=async()=>{calls++;return {status:44,stdout:Buffer.alloc(0)};};
 for(const platform of ['win32','linux'])await expect(readMemorySaveInputKey({installationId:'installation',platform,runner})).rejects.toThrow('UNSUPPORTED');
 for(const installationId of ['', '../foreign','x'.repeat(129)])await expect(readMemorySaveInputKey({installationId,platform:'darwin',runner})).rejects.toThrow('INVALID_ID');expect(calls).toBe(0);
});

test('command errors are redacted and repeated reads obtain fresh independently owned buffers',async()=>{
 await expect(readMemorySaveInputKey({installationId:'installation',platform:'darwin',runner:async()=>{throw new Error('private command diagnostics');}})).rejects.toThrow('Memory input key: UNAVAILABLE');
 let calls=0;const runner:MemoryInputKeyRunner=async()=>({status:0,stdout:Buffer.from(Buffer.alloc(32,++calls).toString('base64'))});
 const a=await readMemorySaveInputKey({installationId:'installation',platform:'darwin',runner}),b=await readMemorySaveInputKey({installationId:'installation',platform:'darwin',runner});expect(a.equals(b)).toBe(false);expect(calls).toBe(2);a.fill(0);b.fill(0);
});


test('high-bit bytes cannot be masked into an apparently valid base64 key',async()=>{
 const stdout=Buffer.from(Buffer.alloc(32).toString('base64'));stdout[0]=stdout[0]!|128;
 await expect(readMemorySaveInputKey({installationId:'installation',platform:'darwin',runner:async()=>({status:0,stdout})})).rejects.toThrow('MALFORMED');expect(stdout.every(v=>v===0)).toBe(true);
});
