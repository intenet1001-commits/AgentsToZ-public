import {test,expect} from 'bun:test';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CommunityMobileControlLedger} from '../src/communityMobileControlLedger';
import {mobileControlHash} from '../src/communityMobileControlProtocol';

const profile='11111111-1111-4111-8111-111111111111',community='22222222-2222-4222-8222-222222222222',device='33333333-3333-4333-8333-333333333333',owner='a'.repeat(64);
function id(at:number,n:number){const b=Buffer.alloc(16);b.writeUIntBE(at,0,6);b[6]=0x70;b[8]=0x80;b.writeUInt32BE(n,12);const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'mobile-control-ledger-')),key=randomBytes(32);let now=1_800_000_000_000;
  const open=()=>new CommunityMobileControlLedger(root,{profileId:profile,communityId:community,deviceId:device},key,()=>now);
  const row=(n:number)=>({owner,operationId:id(now,n),createdAt:now,purpose:'mobile-teams' as const,commandDigest:mobileControlHash('request-'+n),scope:'private-project-binding',executionBoot:'b'.repeat(32)});
  return {root,key,open,row,get now(){return now;},set now(v:number){now=v;},close:()=>{key.fill(0);rmSync(root,{recursive:true,force:true});}};
}
test('persist-before-execution, original-owner recovery and exact-result consumption survive restart without plaintext',()=>{
  const f=fixture();let store=f.open();try{
    const row=f.row(1),original=JSON.stringify({outcome:'accepted',private:'private-mobile-result-marker'});
    expect(store.reserve(row).fresh).toBe(true);expect(store.reserve(row).fresh).toBe(false);
    expect(()=>store.reserve({...row,commandDigest:mobileControlHash('changed')})).toThrow('CONFLICT');
    store.settle(owner,row.operationId,original);store.close();store=f.open();
    expect(store.get(owner,row.operationId)?.result).toBe(original);
    expect(store.get('c'.repeat(64),row.operationId)).toBeNull();
    for(const file of readdirSync(f.root,{recursive:true}) as string[]){const p=join(f.root,file);if(file.endsWith('.sqlite')||file.endsWith('-wal'))expect(readFileSync(p).includes(Buffer.from('private-mobile-result-marker'))).toBe(false);}
    expect(store.consume(owner,row.operationId,row.createdAt,'0'.repeat(64))).toBe(false);
    expect(store.consume(owner,row.operationId,row.createdAt,mobileControlHash(original))).toBe(true);
    expect(store.get(owner,row.operationId)?.result).toBeNull();
    f.now+=60_000;store.compact();expect(store.get(owner,row.operationId)).toBeNull();
    expect(store.missingState(row.operationId)).toBe('expired');
    expect(()=>store.reserve(row)).toThrow('EXPIRED');
    expect(()=>store.reserve({...row,createdAt:f.now})).toThrow('EXPIRED');
  }finally{store.close();f.close();}
});
test('over 512 completed operations continue while unknown and unconsumed original results remain protected',()=>{
  const f=fixture();let store=f.open();try{
    const unknown=f.row(1),unconsumed=f.row(2);store.reserve(unknown);store.unknown(owner,unknown.operationId);store.reserve(unconsumed);store.settle(owner,unconsumed.operationId,'{"outcome":"accepted"}');
    let effects=0;
    for(let n=3;n<603;n++){
      const row=f.row(n);if(store.reserve(row).fresh)effects++;
      const result=JSON.stringify({outcome:'done',n});store.settle(owner,row.operationId,result);store.consume(owner,row.operationId,row.createdAt,mobileControlHash(result));
      if(n%100===0){store.close();store=f.open();}f.now+=100;
    }
    expect(effects).toBe(600);store.compact();
    expect(store.get(owner,unknown.operationId)?.state).toBe('unknown');
    expect(store.get(owner,unconsumed.operationId)?.result).toBe('{"outcome":"accepted"}');
    const oldNow=f.now;f.now-=120_000;expect(()=>store.reserve(f.row(900))).toThrow('EXPIRED');f.now=oldNow;
    expect(store.consume(owner,unknown.operationId,unknown.createdAt,'0'.repeat(64))).toBe(false);
  }finally{store.close();f.close();}
});
test('unconsumed capacity, invalid identity/key and oversized or changed results refuse without evicting evidence',()=>{
  const f=fixture();let store=f.open();try{
    const first=f.row(1);store.reserve(first);
    expect(()=>store.settle(owner,first.operationId,JSON.stringify({text:'x'.repeat(16_001)}))).toThrow();
    expect(store.get(owner,first.operationId)?.state).toBe('pending');
    store.unknown(owner,first.operationId);store.settle(owner,first.operationId,'{"outcome":"recovered"}');
    expect(()=>store.settle(owner,first.operationId,'{"outcome":"different"}')).toThrow('CONFLICT');
    for(let n=2;n<=512;n++)store.reserve(f.row(n));
    expect(()=>store.reserve(f.row(513))).toThrow('FULL');expect(store.get(owner,first.operationId)?.result).toBe('{"outcome":"recovered"}');
    store.close();expect(()=>new CommunityMobileControlLedger(f.root,{profileId:profile,communityId:community,deviceId:device},randomBytes(32),()=>f.now)).toThrow('KEY_MISMATCH');store=f.open();
    expect(()=>store.reserve({...f.row(600),operationId:device})).toThrow();
  }finally{store.close();f.close();}
});
