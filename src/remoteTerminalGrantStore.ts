import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {closeSync,fsyncSync,mkdirSync,openSync,writeFileSync} from 'node:fs';
import {withOwnedPortalFileLock,withPortalFileLockCoordinator} from './portalFileLock';
import {pathEntryExists,readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';
import {validateRemoteTerminalGrant,type RemoteTerminalGrant,type RemoteTerminalGrantStore} from './remoteTerminalGrant';
/** Bounded cross-process ownership protects the complete read/CAS/write transaction.
 * Keep revocation revisions; capacity rejects new grants, never evicts live consent. */
export class PrivateRemoteTerminalGrantStore implements RemoteTerminalGrantStore {
 readonly path:string;
 #hostId:string|undefined;
 constructor(private readonly appDataDir:string){
  this.path=join(appDataDir,'remote-terminal-grants-v1.json');
 }
 get hostId():string {
  if(this.#hostId)return this.#hostId;
  const identityPath=join(this.appDataDir,'remote-terminal-host-v1.key');
  mkdirSync(this.appDataDir,{recursive:true,mode:0o700});
  // All new readers share the short cross-process transaction. An O_EXCL
  // winner's empty inode must not be observed before its write/fsync finishes.
  return withPortalFileLockCoordinator(identityPath,()=>{
  let identity=readPrivateFileStrict(identityPath);
  if(identity===null){
    if(pathEntryExists(identityPath))throw new Error('워크룸 호스트 신원을 읽을 수 없습니다.');
    mkdirSync(this.appDataDir,{recursive:true,mode:0o700});
    let descriptor:number|undefined;
    try {
      // Exclusive creation never replaces the identity won by another process.
      descriptor=openSync(identityPath,'wx',0o600);
      writeFileSync(descriptor,randomBytes(32).toString('base64url'),'utf8');fsyncSync(descriptor);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    finally{if(descriptor!==undefined)closeSync(descriptor);}
    identity=readPrivateFileStrict(identityPath);
    // A concurrent creator or interrupted write may be incomplete; fail closed and
    // let a later request retry, never overwrite the existing key with another.
    if(identity===null)throw new Error('워크룸 호스트 신원을 준비 중입니다. 다시 확인하세요.');
  }
  if(!/^[A-Za-z0-9_-]{43}$/.test(identity))throw new Error('워크룸 호스트 신원 형식 오류');
  this.#hostId=identity;
  return identity;
  });
 }
 #read():RemoteTerminalGrant[]{
  const text=readPrivateFileStrict(this.path);
  if(text===null){if(pathEntryExists(this.path))throw new Error('저장된 워크룸 기기 권한을 읽을 수 없습니다.');return [];}
  if(text.length>512*1024)throw new Error('워크룸 권한 저장소 크기 한도를 초과했습니다.');
  const value=JSON.parse(text);
  if(value.schemaVersion!==1||!Array.isArray(value.grants)||value.grants.length>256)throw new Error('워크룸 권한 저장소 형식 오류');
  value.grants.forEach(validateRemoteTerminalGrant);
  if(new Set(value.grants.map((g:RemoteTerminalGrant)=>JSON.stringify([g.hostId,g.controllerId]))).size!==value.grants.length)throw new Error('중복 워크룸 권한');
  return value.grants;
 }
 current(hostId:string,controllerId:string){return this.#read().find(g=>g.hostId===hostId&&g.controllerId===controllerId)??null;}
 async find(hostId:string,controllerId:string){return this.current(hostId,controllerId);}
 async update(grant:RemoteTerminalGrant,expectedRevision:number|null){
  validateRemoteTerminalGrant(grant);
  mkdirSync(this.appDataDir,{recursive:true,mode:0o700});
  return withOwnedPortalFileLock(`${this.path}.lock`,()=>{
  const grants=this.#read(),index=grants.findIndex(g=>g.hostId===grant.hostId&&g.controllerId===grant.controllerId);
  if(expectedRevision===null?index!==-1:index===-1||grants[index]!.revision!==expectedRevision)return false;
  if(grant.revision!==(expectedRevision??0)+1)throw new Error('워크룸 권한 revision 충돌');
  if(index===-1){if(grants.length>=256)throw new Error('워크룸 승인 기기 한도에 도달했습니다.');grants.push(grant);}else grants[index]=grant;
  const serialized=JSON.stringify({schemaVersion:1,grants});
  if(serialized.length>512*1024)throw new Error('워크룸 권한 저장소 크기 한도를 초과했습니다.');
  writePrivateFileAtomically(this.appDataDir,this.path,serialized);return true;
  },{label:'remote terminal grants',attempts:50,retryMs:20,deadOwnerRecoveryClass:'manual',canRecoverDeadOwner:()=>false});
 }
}
