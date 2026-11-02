import {createHash} from 'node:crypto';
import {closeSync,constants,fstatSync,lstatSync,openSync,renameSync,writeSync,fsyncSync,type Stats} from 'node:fs';
import {join} from 'node:path';
import {CommunityDeviceAuthorization} from './communityMobilePrincipal';
import type {CommunityMobileRelayPurpose} from './communityAccessClient';
import {acquireOwnedFileLock,type OwnedFileLockRelease} from './portalFileLock';
import {createProductionPromptGuideKeyProvider,promptGuideDirectory,readPromptGuideFile,syncPromptGuideDirectory,
  type PromptGuideKeyProvider,type SecureAppDataKeyNamespace} from './promptGuideKeyProvider';

export interface CommunityMobileDataKeyScope {profileId:string;communityId:string;deviceId:string}
interface Marker extends CommunityMobileDataKeyScope {version:1;fingerprint:string}
export class CommunityMobileDataKeyError extends Error {
  constructor(readonly code:string){super(code);this.name='CommunityMobileDataKeyError';}
}
function fail(code:string):never{throw new CommunityMobileDataKeyError(code);}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
function scopeJSON(scope:CommunityMobileDataKeyScope):string {
  if(!scope||![scope.profileId,scope.communityId,scope.deviceId].every(uuid))fail('MOBILE_DATA_KEY_IDENTITY');
  return JSON.stringify([2,scope.profileId,scope.communityId,scope.deviceId]);
}
/** Public paths only. Keep the ledger's exact namespace while giving this key its own OS-vault account. */
export function communityMobileDataKeyLocations(directory:string,scope:CommunityMobileDataKeyScope){
  const identity=scopeJSON(scope),id=hash('agentstoz.community-mobile-control/data-key-namespace/v1\0'+identity);
  const base=`community-mobile-control-data-key-${id}`;
  const ledger=join(directory,`community-mobile-control-${hash(identity).slice(0,24)}.sqlite`);
  const namespace:SecureAppDataKeyNamespace={keychainService:'com.portmanager.portmanager.community-mobile-control-data.v1',
    keychainAccount:id,dpapiFile:base+'.dpapi',dpapiEntropy:'agentstoz-community-mobile-control-data-key-v1-'+id};
  return Object.freeze({marker:join(directory,base+'.json'),pending:join(directory,base+'.json.next'),lock:join(directory,base+'.lock'),
    ledgerFiles:Object.freeze([ledger,ledger+'-wal',ledger+'-shm',ledger+'-journal']),namespace:Object.freeze(namespace)});
}
function regularMetadata(path:string):Stats|null {
  let s:Stats;
  try{s=lstatSync(path);}catch(e:any){if(e?.code==='ENOENT')return null;return fail('MOBILE_DATA_KEY_UNSAFE');}
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||process.platform!=='win32'&&((s.mode&0o077)!==0||process.getuid&&s.uid!==process.getuid()))fail('MOBILE_DATA_KEY_UNSAFE');
  return s;
}
function marker(path:string,scope:CommunityMobileDataKeyScope):Marker|null {
  if(!regularMetadata(path))return null;
  try{
    const raw=readPromptGuideFile(path,4096);if(!raw)return fail('MOBILE_DATA_KEY_UNAVAILABLE');
    const value:unknown=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
    if(!value||typeof value!=='object'||Array.isArray(value))return fail('MOBILE_DATA_KEY_CORRUPT');
    const v=value as Marker;
    if(Object.keys(v).sort().join(',')!=='communityId,deviceId,fingerprint,profileId,version'||v.version!==1||v.profileId!==scope.profileId||v.communityId!==scope.communityId||v.deviceId!==scope.deviceId||typeof v.fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(v.fingerprint)||JSON.stringify(v)+'\n'!==raw.toString('utf8'))return fail('MOBILE_DATA_KEY_CORRUPT');
    return v;
  }catch(e){if(e instanceof CommunityMobileDataKeyError)throw e;return fail('MOBILE_DATA_KEY_CORRUPT');}
}
function fingerprint(key:Buffer,scope:CommunityMobileDataKeyScope):string {
  if(!Buffer.isBuffer(key)||key.length!==32)fail('MOBILE_DATA_KEY_MALFORMED');
  return createHash('sha256').update('agentstoz.community-mobile-control/data-key-fingerprint/v1\0').update(scopeJSON(scope)).update(key).digest('hex');
}

/** Prepare only after Native's current receiver authorization. Never reads or initializes a dialogue endpoint.
 * The caller owns the returned 32-byte copy and must clear it after constructing the encrypted ledger. */
export async function prepareCommunityMobileDataKey(input:{appDataDir:string;receiver:CommunityDeviceAuthorization;purpose:CommunityMobileRelayPurpose;
  keyProvider?:PromptGuideKeyProvider;now?:()=>number}):Promise<Buffer>{
  const now=input.now??Date.now;
  const authorized=()=>{if(!CommunityDeviceAuthorization.isVerified(input.receiver)||input.receiver.body.deviceKind!=='desktop'||!input.receiver.permits(input.purpose,now()))fail('MOBILE_DATA_KEY_AUTH_REQUIRED');};
  authorized();
  const body=input.receiver.body,scope={profileId:body.profileId,communityId:body.communityId,deviceId:body.deviceId};
  let release:OwnedFileLockRelease|undefined,key:Buffer|null=null;
  try{
    const directory=promptGuideDirectory(input.appDataDir,true)!,root=lstatSync(directory),paths=communityMobileDataKeyLocations(directory,scope);
    if(process.platform!=='win32'&&((root.mode&0o022)!==0||process.getuid&&root.uid!==process.getuid()))fail('MOBILE_DATA_KEY_UNSAFE');
    const valid=()=>{
      authorized();const live=lstatSync(directory);
      if(!live.isDirectory()||live.isSymbolicLink()||live.dev!==root.dev||live.ino!==root.ino||!release?.refresh())fail('MOBILE_DATA_KEY_LOCK_LOST');
    };
    try{release=await acquireOwnedFileLock(paths.lock,{label:'mobile-control-data-key',attempts:100,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});}
    catch(e:any){return fail(e?.code==='FILE_LOCK_RECOVERY_REQUIRED'?'MOBILE_DATA_KEY_RECOVERY_REQUIRED':'MOBILE_DATA_KEY_LOCKED');}
    valid();
    const provider=input.keyProvider??createProductionPromptGuideKeyProvider({appDataDir:directory,namespace:paths.namespace});
    const read=async()=>{try{
      const value=await provider.read();if(value!==null&&(!Buffer.isBuffer(value)||value.length!==32)){value?.fill?.(0);fail('MOBILE_DATA_KEY_MALFORMED');}return value;
    }catch(e){if(e instanceof CommunityMobileDataKeyError)throw e;return fail('MOBILE_DATA_KEY_UNAVAILABLE');}};
    // Check all paths even when the first one exists: an unsafe WAL/SHM cannot hide behind the main DB.
    const hasHistory=()=>{let found=false;for(const path of paths.ledgerFiles)if(regularMetadata(path))found=true;return found;};
    let recorded=marker(paths.marker,scope),pending=marker(paths.pending,scope),ledger=hasHistory();
    key=await read();valid();
    if(!key&&(recorded||pending||ledger))fail('MOBILE_DATA_KEY_MISSING');
    if(ledger&&!recorded)fail('MOBILE_DATA_KEY_HISTORY_WITHOUT_MARKER');
    if(recorded&&pending)fail('MOBILE_DATA_KEY_SETUP_INCOMPLETE');
    if(!key){
      // Null is a definitive absence. Locked/unavailable/malformed reads never enter this branch.
      if(recorded||pending||ledger)fail('MOBILE_DATA_KEY_MISSING');
      valid();if(marker(paths.marker,scope)||marker(paths.pending,scope)||hasHistory())fail('MOBILE_DATA_KEY_HISTORY_WITHOUT_MARKER');
      try{key=await provider.create();}catch{return fail('MOBILE_DATA_KEY_UNAVAILABLE');}
      valid();fingerprint(key,scope);
      const expected=fingerprint(key,scope);key.fill(0);key=null;
      key=await read();valid();if(!key)fail('MOBILE_DATA_KEY_MISSING');if(fingerprint(key,scope)!==expected)fail('MOBILE_DATA_KEY_MISMATCH');
    }
    const expected=fingerprint(key,scope);
    // Re-observe all public evidence after any awaited vault operation and reject identity/file substitution.
    const fresh=marker(paths.marker,scope),next=marker(paths.pending,scope);
    if(JSON.stringify(fresh)!==JSON.stringify(recorded)||JSON.stringify(next)!==JSON.stringify(pending))fail('MOBILE_DATA_KEY_UNAVAILABLE');
    ledger=hasHistory();if(!recorded&&ledger)fail('MOBILE_DATA_KEY_HISTORY_WITHOUT_MARKER');
    if(recorded&&recorded.fingerprint!==expected||pending&&pending.fingerprint!==expected)fail('MOBILE_DATA_KEY_MISMATCH');
    if(!recorded){
      if(!pending){
        const bytes=Buffer.from(JSON.stringify({version:1,...scope,fingerprint:expected})+'\n');
        const fd=openSync(paths.pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
        try{if(!fstatSync(fd).isFile())fail('MOBILE_DATA_KEY_UNSAFE');let at=0;while(at<bytes.length){const n=writeSync(fd,bytes,at,bytes.length-at);if(!n)fail('MOBILE_DATA_KEY_UNAVAILABLE');at+=n;}fsyncSync(fd);}
        finally{closeSync(fd);}
        syncPromptGuideDirectory(directory);pending=marker(paths.pending,scope);
      }
      valid();if(!pending||pending.fingerprint!==expected||marker(paths.marker,scope)||hasHistory())fail('MOBILE_DATA_KEY_SETUP_INCOMPLETE');
      renameSync(paths.pending,paths.marker);syncPromptGuideDirectory(directory);recorded=marker(paths.marker,scope);
    }
    valid();if(!recorded||recorded.fingerprint!==expected||marker(paths.pending,scope))fail('MOBILE_DATA_KEY_MISMATCH');
    syncPromptGuideDirectory(directory);
    if(!release())fail('MOBILE_DATA_KEY_LOCK_LOST');release=undefined;
    const result=key;key=null;return result;
  }catch(e){if(e instanceof CommunityMobileDataKeyError)throw e;return fail('MOBILE_DATA_KEY_UNAVAILABLE');}
  finally{key?.fill(0);try{release?.();}catch{}}
}
