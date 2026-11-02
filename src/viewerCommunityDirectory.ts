import {constants,closeSync,fsyncSync,openSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {communityDeviceRef,type CommunityDeviceRow} from './communityDeviceRef';

/** Advisory discovery only. No address, identity key, credential, grant or session command crosses this file. */
export const VIEWER_COMMUNITY_FILE='viewer-community.json';
export const VIEWER_COMMUNITY_TTL_MS=90_000;
export interface ViewerCommunitySnapshot {inside:boolean;devices:readonly CommunityDeviceRow[]}
export function viewerCommunityDirectory(snapshot:ViewerCommunitySnapshot,now=Date.now()){
  const seen=new Set<string>();
  const devices:{ref:string;name:string;lastSeenAt:number|null}[]=[];
  for(const device of snapshot.inside?snapshot.devices.slice(0,1024):[]){
    if(devices.length===64)break;
    const name=device.displayName.trim();
    if(!name||Buffer.byteLength(name)>240||/[\p{Cc}\p{Cf}]/u.test(name)||seen.has(device.deviceId))continue;
    seen.add(device.deviceId);
    const parsed=device.lastSeenAt===null?NaN:Date.parse(device.lastSeenAt);
    devices.push({ref:communityDeviceRef(device.deviceId),name,lastSeenAt:Number.isSafeInteger(parsed)&&parsed>=0&&parsed<=now+5_000?parsed:null});
  }
  return {schemaVersion:1,generatedAt:now,expiresAt:now+VIEWER_COMMUNITY_TTL_MS,inside:snapshot.inside,devices};
}

/** Atomically replaces one owner-only hint file. A failed export never interrupts community operations. */
export function createViewerCommunityPublisher(appDataDir:string,now=Date.now){
  const destination=join(appDataDir,VIEWER_COMMUNITY_FILE);
  return (snapshot:ViewerCommunitySnapshot)=>{
    const temporary=join(appDataDir,`.viewer-community-${randomUUID()}.tmp`);
    let fd:number|undefined;
    try{
      fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,JSON.stringify(viewerCommunityDirectory(snapshot,now())));
      fsyncSync(fd);closeSync(fd);fd=undefined;
      renameSync(temporary,destination);
    }finally{
      if(fd!==undefined)closeSync(fd);
      try{unlinkSync(temporary);}catch{}
    }
  };
}
