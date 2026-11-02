import {expect,test} from 'bun:test';
import {createECDH,createPrivateKey,randomUUID,sign} from 'node:crypto';
import {chmodSync,existsSync,linkSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,symlinkSync,unlinkSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {prepareCommunityMobileDataKey,communityMobileDataKeyLocations} from '../src/communityMobileDataKey';
import {CommunityDeviceAuthorization} from '../src/communityMobilePrincipal';
import {CommunityMobileControlLedger} from '../src/communityMobileControlLedger';
import {acquireOwnedFileLock} from '../src/portalFileLock';
import {PROMPT_GUIDES_KEYCHAIN_SERVICE,type PromptGuideKeyProvider} from '../src/promptGuideKeyProvider';
import golden from '../native/screen-control/Tests/Fixtures/community-mobile-control-v2.json';

const scalar=Buffer.alloc(32);scalar.writeUInt32BE(golden.softwareKeyScalars.issuer,28);
const ecdh=createECDH('prime256v1');ecdh.setPrivateKey(scalar);const point=ecdh.getPublicKey();
const issuer=createPrivateKey({format:'jwk',key:{kty:'EC',crv:'P-256',d:scalar.toString('base64url'),x:point.subarray(1,33).toString('base64url'),y:point.subarray(33).toString('base64url')}});
async function authorization(body:any=golden.receiverAuthorization){
  const payload=Buffer.from(JSON.stringify([2,'authorization',randomUUID(),golden.now,body]));
  const envelope={payload:payload.toString('base64url'),signature:sign('sha256',Buffer.concat([Buffer.from('agentstoz.community-access.response/v2\0'),payload]),{key:issuer,dsaEncoding:'ieee-p1363'}).toString('base64url')};
  return CommunityDeviceAuthorization.fromEnvelope(envelope,{...golden.authority,profileId:body.profileId},{communityId:body.communityId,deviceId:body.deviceId,deviceKind:body.deviceKind},golden.now);
}
class SoftwareVault implements PromptGuideKeyProvider {
  present:Buffer|null=null;reads=0;creates=0;locked=false;persistThenFail=false;block:Promise<void>|undefined;returned:Buffer[]=[];
  async read(){++this.reads;if(this.locked)throw Error('fixture locked; private key status');if(this.block)await this.block;const value=this.present?Buffer.from(this.present):null;if(value)this.returned.push(value);return value;}
  async create(){++this.creates;if(this.locked)throw Error('fixture locked');await new Promise(r=>setTimeout(r,10));this.present??=Buffer.alloc(32,7);if(this.persistThenFail){this.persistThenFail=false;throw Error('fixture crashed after add-only vault persistence');}const value=Buffer.from(this.present);this.returned.push(value);return value;}
}
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'mobile-data-key-fixture-'));chmodSync(root,0o700);
  const receiver=await authorization(),vault=new SoftwareVault();let at=golden.now;
  const input={appDataDir:root,receiver,purpose:'mobile-agent' as const,keyProvider:vault,now:()=>at};
  const paths=communityMobileDataKeyLocations(root,receiver.body);
  return {root,receiver,vault,input,paths,advance:(ms:number)=>{at+=ms;},close:()=>{vault.present?.fill(0);for(const key of vault.returned)key.fill(0);rmSync(root,{recursive:true,force:true});}};
}

test('a freshly authorized Main prepares a separate data key with no dialogue endpoints or prior storage',async()=>{
  const f=await fixture();try{
    const key=await prepareCommunityMobileDataKey(f.input);expect(key.length).toBe(32);expect(f.vault.creates).toBe(1);
    expect(f.paths.namespace.keychainService).not.toBe(PROMPT_GUIDES_KEYCHAIN_SERVICE);expect(f.paths.namespace.keychainAccount).toMatch(/^[0-9a-f]{64}$/);
    const raw=readFileSync(f.paths.marker,'utf8'),marker=JSON.parse(raw);expect(Object.keys(marker).sort()).toEqual(['communityId','deviceId','fingerprint','profileId','version']);
    expect(marker).toMatchObject({version:1,profileId:f.receiver.body.profileId,communityId:f.receiver.body.communityId,deviceId:f.receiver.body.deviceId});
    expect(raw).not.toContain(key.toString('base64'));expect(raw).not.toContain(key.toString('hex'));expect(statSync(f.paths.marker).mode&0o777).toBe(0o600);
    expect(readdirSync(f.root).some(n=>/dialogue|endpoint|prompt-guides|memory-save/.test(n))).toBe(false);
    const ledger=new CommunityMobileControlLedger(f.root,f.receiver.body,key,()=>golden.now);key.fill(0);ledger.close();
    const reopened=await prepareCommunityMobileDataKey(f.input);const next=new CommunityMobileControlLedger(f.root,f.receiver.body,reopened,()=>golden.now);next.close();reopened.fill(0);
    expect(f.vault.creates).toBe(1);expect(existsSync(f.paths.pending)).toBe(false);
  }finally{f.close();}
});

test('concurrent factories share the existing owned-file lock and create exactly one authoritative key',async()=>{
  const f=await fixture();try{
    const keys=await Promise.all(Array.from({length:8},()=>prepareCommunityMobileDataKey(f.input)));
    expect(f.vault.creates).toBe(1);expect(keys.every(k=>k.equals(Buffer.alloc(32,7)))).toBe(true);
    keys[0]!.fill(0);expect(keys[1]!.equals(Buffer.alloc(32,7))).toBe(true);for(const key of keys)key.fill(0);
    expect(existsSync(f.paths.lock)).toBe(false);
  }finally{f.close();}
});

test('lost or changed keys never regenerate after marker or ledger history exists',async()=>{
  const f=await fixture();try{
    const key=await prepareCommunityMobileDataKey(f.input);const ledger=new CommunityMobileControlLedger(f.root,f.receiver.body,key,()=>golden.now);ledger.close();key.fill(0);
    const before=readFileSync(f.paths.marker);f.vault.present?.fill(0);f.vault.present=null;
    await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow('MOBILE_DATA_KEY_MISSING');expect(f.vault.creates).toBe(1);
    f.vault.present=Buffer.alloc(32,9);await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow('MOBILE_DATA_KEY_MISMATCH');
    expect(f.vault.creates).toBe(1);expect(readFileSync(f.paths.marker)).toEqual(before);expect(f.vault.returned.at(-1)!.every(x=>x===0)).toBe(true);
  }finally{f.close();}
});

test('any old ledger, WAL, SHM or journal without the new marker refuses migration even with an existing key',async()=>{
  for(const index of [0,1,2,3])for(const present of [false,true]){
    const f=await fixture();try{
      writeFileSync(f.paths.ledgerFiles[index]!,Buffer.alloc(0),{mode:0o600});if(present)f.vault.present=Buffer.alloc(32,7);
      await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow(present?'MOBILE_DATA_KEY_HISTORY_WITHOUT_MARKER':'MOBILE_DATA_KEY_MISSING');
      expect(f.vault.creates).toBe(0);expect(existsSync(f.paths.marker)).toBe(false);
    }finally{f.close();}
  }
});

test('locked, unavailable and malformed vault reads are distinct from first-save absence and never create',async()=>{
  const f=await fixture();try{
    f.vault.locked=true;await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow('MOBILE_DATA_KEY_UNAVAILABLE');expect(f.vault.creates).toBe(0);
    f.vault.locked=false;f.vault.present=Buffer.alloc(16,5);await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow('MOBILE_DATA_KEY_MALFORMED');expect(f.vault.creates).toBe(0);
    expect(existsSync(f.paths.marker)).toBe(false);
  }finally{f.close();}
});

test('an interrupted first key add recovers only from the same existing key and no ledger history',async()=>{
  const f=await fixture();try{
    f.vault.persistThenFail=true;await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow('MOBILE_DATA_KEY_UNAVAILABLE');
    expect(f.vault.present).not.toBeNull();expect(existsSync(f.paths.marker)).toBe(false);expect(f.vault.creates).toBe(1);
    const key=await prepareCommunityMobileDataKey(f.input);expect(key.equals(f.vault.present!)).toBe(true);key.fill(0);expect(f.vault.creates).toBe(1);
    renameSync(f.paths.marker,f.paths.pending);const recovered=await prepareCommunityMobileDataKey(f.input);recovered.fill(0);
    expect(existsSync(f.paths.marker)).toBe(true);expect(existsSync(f.paths.pending)).toBe(false);expect(f.vault.creates).toBe(1);
  }finally{f.close();}
  const old=await fixture();try{
    old.vault.persistThenFail=true;await expect(prepareCommunityMobileDataKey(old.input)).rejects.toThrow();
    writeFileSync(old.paths.ledgerFiles[0]!,Buffer.alloc(0),{mode:0o600});await expect(prepareCommunityMobileDataKey(old.input)).rejects.toThrow('MOBILE_DATA_KEY_HISTORY_WITHOUT_MARKER');expect(old.vault.creates).toBe(1);
  }finally{old.close();}
});

test('pending marker evidence, changed marker identity and unsafe files never permit replacement',async()=>{
  for(const mode of ['missing','bad-fingerprint','bad-identity','duplicate','oversize','permissions','symlink','hardlink','pending-and-ready']){
    const f=await fixture();try{
      const key=await prepareCommunityMobileDataKey(f.input);key.fill(0);const original=readFileSync(f.paths.marker,'utf8');
      if(mode==='missing'){renameSync(f.paths.marker,f.paths.pending);f.vault.present?.fill(0);f.vault.present=null;}
      if(mode==='bad-fingerprint')writeFileSync(f.paths.marker,JSON.stringify({...JSON.parse(original),fingerprint:'0'.repeat(64)})+'\n');
      if(mode==='bad-identity')writeFileSync(f.paths.marker,JSON.stringify({...JSON.parse(original),deviceId:randomUUID()})+'\n');
      if(mode==='duplicate')writeFileSync(f.paths.marker,'{"version":9,'+original.slice(1));
      if(mode==='oversize')writeFileSync(f.paths.marker,'x'.repeat(4097));
      if(mode==='permissions')chmodSync(f.paths.marker,0o644);
      if(mode==='symlink'||mode==='hardlink'){
        const other=join(f.root,'original-marker');renameSync(f.paths.marker,other);
        if(mode==='symlink')symlinkSync(other,f.paths.marker);else linkSync(other,f.paths.marker);
      }
      if(mode==='pending-and-ready')writeFileSync(f.paths.pending,original,{mode:0o600});
      await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow();expect(f.vault.creates).toBe(1);
    }finally{f.close();}
  }
});

test('authorization and purpose are verified before directory, vault or lock preparation',async()=>{
  const f=await fixture();try{
    const mobile=await authorization(golden.mobileAuthorization),browser=await authorization({...golden.receiverAuthorization,capabilities:['computer-use.browser'],agentDeviceId:null});
    for(const changes of [{receiver:Object.create(CommunityDeviceAuthorization.prototype)},{receiver:mobile},{receiver:browser},{purpose:'agent' as any},{now:()=>golden.now+90_000}]){
      await expect(prepareCommunityMobileDataKey({...f.input,...changes})).rejects.toThrow('MOBILE_DATA_KEY_AUTH_REQUIRED');
    }
    expect(f.vault.reads).toBe(0);expect(f.vault.creates).toBe(0);expect(readdirSync(f.root)).toEqual([]);
    const key=await prepareCommunityMobileDataKey({...f.input,receiver:browser,purpose:'mobile-browser'});key.fill(0);expect(f.vault.creates).toBe(1);
  }finally{f.close();}
});

test('profile, community and CF-device namespaces are separate while renewed revisions keep the existing local data key',async()=>{
  const f=await fixture();try{
    const key=await prepareCommunityMobileDataKey(f.input);key.fill(0);
    const revised=await authorization({...golden.receiverAuthorization,revision:2,keyEpoch:2});
    const next=await prepareCommunityMobileDataKey({...f.input,receiver:revised});next.fill(0);expect(f.vault.creates).toBe(1);
    for(const field of ['profileId','communityId','deviceId'] as const){
      const scope={...f.receiver.body,[field]:randomUUID()},locations=communityMobileDataKeyLocations(f.root,scope);
      expect(locations.namespace.keychainAccount).not.toBe(f.paths.namespace.keychainAccount);expect(locations.marker).not.toBe(f.paths.marker);expect(locations.ledgerFiles[0]).not.toBe(f.paths.ledgerFiles[0]);
    }
  }finally{f.close();}
});

test('a late vault read cannot finish preparation after the receiver authorization expires',async()=>{
  const f=await fixture();try{
    f.vault.present=Buffer.alloc(32,7);let unblock!:()=>void;f.vault.block=new Promise<void>(r=>{unblock=r;});
    const pending=prepareCommunityMobileDataKey(f.input);while(f.vault.reads===0)await new Promise(r=>setTimeout(r,1));f.advance(90_000);unblock();
    await expect(pending).rejects.toThrow('MOBILE_DATA_KEY_AUTH_REQUIRED');expect(existsSync(f.paths.marker)).toBe(false);expect(f.vault.returned.at(-1)!.every(x=>x===0)).toBe(true);
  }finally{f.close();}
});

test('live and dead manual owner locks are never stolen, including an old mtime',async()=>{
  const f=await fixture();let release:(()=>boolean)|undefined;
  try{
    release=await acquireOwnedFileLock(f.paths.lock,{deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
    const owner=readFileSync(f.paths.lock);await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow('MOBILE_DATA_KEY_LOCKED');expect(readFileSync(f.paths.lock)).toEqual(owner);release();release=undefined;
    const dead='v3:2147483647:'+'a'.repeat(32)+':manual';writeFileSync(f.paths.lock,dead,{mode:0o600});utimesSync(f.paths.lock,new Date(0),new Date(0));
    await expect(prepareCommunityMobileDataKey(f.input)).rejects.toThrow('MOBILE_DATA_KEY_RECOVERY_REQUIRED');expect(readFileSync(f.paths.lock,'utf8')).toBe(dead);
    expect(f.vault.reads).toBe(0);expect(f.vault.creates).toBe(0);
  }finally{release?.();f.close();}
},10_000);
