import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {createCipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CommunityControlLedger,communityControlId,communityControlIdTime,type CommunityControlRow} from '../src/authenticatedCommunityTransport';

function fixture(){
  const root=mkdtempSync(join(tmpdir(),'control-ledger-')),profile=randomUUID(),device=randomUUID(),key=randomBytes(32);let now=Date.now();
  let ledger=new CommunityControlLedger(root,profile,device,Buffer.from(key),()=>now);
  const row=(patch:Partial<CommunityControlRow>={}):CommunityControlRow=>({id:communityControlId(now),profile,device,direction:'in',sourceEndpoint:randomUUID(),targetEndpoint:randomUUID(),
    fromDevice:randomUUID(),toDevice:device,purpose:'agent',digest:'d'.repeat(64),createdAt:now,state:'done',request:null,response:{ok:true},peerPolicy:'p'.repeat(64),ownPolicy:'o'.repeat(64),...patch});
  return {root,key,profile,device,row,get ledger(){return ledger;},get now(){return now;},advance:(ms:number)=>{now+=ms;},reopen:()=>{ledger.close();ledger=new CommunityControlLedger(root,profile,device,Buffer.from(key),()=>now);},
    stats:()=>{const db=new Database(join(root,readdirSync(root).find(n=>n.endsWith('.sqlite'))!),{readonly:true});try{return db.query('SELECT compact,count(*) n,sum(body_bytes) bytes FROM control_rows GROUP BY compact').all() as {compact:number;n:number;bytes:number}[];}finally{db.close();}},
    close:()=>{ledger.close();key.fill(0);rmSync(root,{recursive:true,force:true});}};
}

test('time-bound consumed receipts retire after their admission window, with a durable clock-regression fence',()=>{
  const f=fixture();try{
    const first=f.row({response:null,consumed:true});expect(communityControlIdTime(first.id)).toBe(f.now);f.ledger.put(first);
    for(let i=0;i<700;i++){f.ledger.put(f.row({response:null,consumed:true}));f.advance(100);}
    expect(f.ledger.get(first.id)).toBeUndefined();expect(f.stats()[0]!.n).toBeLessThan(512);
    const floor=f.ledger.retiredBefore;f.reopen();f.advance(-60_000);f.ledger.compact();expect(f.ledger.retiredBefore).toBeGreaterThanOrEqual(floor);
    expect(communityControlIdTime(first.id)!).toBeLessThan(f.ledger.retiredBefore);
    expect(communityControlIdTime(randomUUID())).toBeNull();
  }finally{f.close();}
});

test('unconsumed, legacy, unknown and unconfirmed-consumption records survive compaction and restart',()=>{
  const f=fixture();try{
    const protectedRows=[f.row({id:randomUUID(),consumed:true}),f.row({state:'unknown',response:null,request:{requestId:randomUUID()}}),
      f.row(),f.row({direction:'out',response:null,consumed:true,ackPending:true})];
    for(const row of protectedRows)f.ledger.put(row);f.advance(3_600_000);f.ledger.compact();f.reopen();
    for(const row of protectedRows)expect(f.ledger.get(row.id)).toEqual(row);
    const acked={...protectedRows[3]!,ackPending:false};f.ledger.put(acked);expect(f.ledger.get(acked.id)).toBeUndefined();
  }finally{f.close();}
});

test('full receipt row and aggregate byte budgets refuse admission without deleting protected work',()=>{
  const f=fixture();try{
    const first=f.row({state:'unknown',response:null});f.ledger.put(first);
    for(let i=1;i<512;i++)f.ledger.put(f.row());
    expect(()=>f.ledger.put(f.row())).toThrow('COMMUNITY_CONTROL_STORE_FULL');f.advance(600_000);f.ledger.compact();
    expect(f.ledger.get(first.id)).toEqual(first);expect(f.stats().find(r=>r.compact===0)!.n).toBe(512);
  }finally{f.close();}
  const bytes=fixture();try{
    const retained=bytes.row({response:{data:'x'.repeat(240_000)}});bytes.ledger.put(retained);let admitted=1;
    for(;admitted<512;admitted++){try{bytes.ledger.put(bytes.row({response:{data:'x'.repeat(240_000)}}));}catch(error){expect(String(error)).toContain('COMMUNITY_CONTROL_STORE_FULL');break;}}
    expect(admitted).toBeLessThan(80);expect(bytes.stats()[0]!.bytes).toBeLessThanOrEqual(16*1024*1024);expect(bytes.ledger.get(retained.id)).toEqual(retained);
    expect(()=>bytes.ledger.put(bytes.row({response:{data:'x'.repeat(300_001)}}))).toThrow('COMMUNITY_CONTROL_ROW_TOO_LARGE');
  }finally{bytes.close();}
});

test('pre-upgrade encrypted SQLite rows migrate without replacing keys, receipt bodies or legacy IDs',()=>{
  const root=mkdtempSync(join(tmpdir(),'old-control-ledger-')),profile=randomUUID(),device=randomUUID(),key=randomBytes(32),id=randomUUID(),at=Date.now()-600_000;
  const file=join(root,`community-control-${createHash('sha256').update(profile+'\0'+device).digest('hex').slice(0,24)}.sqlite`);
  const original:CommunityControlRow={id,profile,device,direction:'in',sourceEndpoint:randomUUID(),targetEndpoint:randomUUID(),fromDevice:randomUUID(),toDevice:device,
    purpose:'agent',digest:'d'.repeat(64),createdAt:at,state:'done',request:null,response:{privateResult:'retain'},peerPolicy:'p'.repeat(64),ownPolicy:'o'.repeat(64)};
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from(id));
  const body=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(original))),cipher.final()]);
  const db=new Database(file);db.exec('CREATE TABLE control_rows(id TEXT PRIMARY KEY,state TEXT,direction TEXT,created_at INTEGER,body BLOB);CREATE TABLE control_metadata(verifier TEXT NOT NULL)');
  db.query('INSERT INTO control_rows VALUES(?,?,?,?,?)').run(id,'done','in',at,Buffer.concat([nonce,cipher.getAuthTag(),body]));
  db.query('INSERT INTO control_metadata VALUES(?)').run(createHash('sha256').update(Buffer.concat([Buffer.from('agentstoz.community-control.store/v1\0'),key])).digest('hex'));db.close();
  let ledger:CommunityControlLedger|undefined;try{
    ledger=new CommunityControlLedger(root,profile,device,Buffer.from(key));ledger.compact();expect(ledger.get(id)).toEqual(original);
    expect(()=>new CommunityControlLedger(root,profile,device,randomBytes(32))).toThrow('COMMUNITY_CONTROL_STORE_KEY_MISMATCH');expect(ledger.get(id)).toEqual(original);
  }finally{ledger?.close();key.fill(0);rmSync(root,{recursive:true,force:true});}
});

test('bounded consumption retry rotates past sixteen old offline-peer records and survives restart',()=>{
  const f=fixture();try{
    const offline=randomUUID(),live=randomUUID(),rows=Array.from({length:20},(_,i)=>{const row=f.row({direction:'out',toDevice:i<16?offline:live,response:null,consumed:true,ackPending:true});f.advance(1);return row;});
    for(const row of rows)f.ledger.put(row);
    const first=f.ledger.pendingConsumption();expect(first).toHaveLength(16);f.reopen();
    const next=f.ledger.pendingConsumption();expect(next).toHaveLength(16);
    expect(new Set([...first,...next].map(row=>row.id)).size).toBe(20);expect(next.some(row=>row.toDevice===live)).toBe(true);
    for(const row of rows)expect(f.ledger.get(row.id)).toEqual(row);
  }finally{f.close();}
});
