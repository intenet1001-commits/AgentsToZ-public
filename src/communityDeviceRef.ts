import {createHash} from 'node:crypto';
import {isCommunityDeviceRef} from './remoteCommunity';
/**
 * 휴대폰이 다른 아젠투지를 가리킬 때 쓰는 불투명 참조.
 *
 * 휴대폰에는 endpointId·participantId·deviceId를 보내지 않는다(`src/remoteCommunity.ts`). 그런데
 * 「3호 워크룸을 몰아라」는 **어느 기기인지 지목**해야 하므로 손잡이가 하나 필요하다. 그래서
 * endpointId에서 결정적으로 유도한 16자리 참조를 보내고, 되돌릴 때는 **그때의 커뮤니티 목록을 다시
 * 읽어** 같은 식으로 계산해 맞춘다. 저장하는 표가 없으니 커뮤니티에서 나간 기기의 참조는 자동으로
 * 아무 것도 가리키지 않는다(fail-closed).
 *
 * ⚠️ 이 파일은 `node:crypto`를 쓰므로 **화면 코드에서 import하지 말 것** — 모양 검사
 * (`isCommunityDeviceRef`)는 브라우저에서도 쓰이므로 `src/remoteCommunity.ts`에 둔다.
 *
 * 해시는 비밀이 아니다 — 참조만으로는 아무 일도 못 한다. 제어는 ① 이 Mac이 커뮤니티에 들어와 있고
 * ② 그 기기도 들어와 있고 ③ 요청한 휴대폰이 이 Mac의 OPS 범위를 허락받았을 때만 통한다.
 */
export function communityDeviceRef(endpointId:string):string{
  return createHash('sha256').update('agentstoz-community-device:'+endpointId).digest('hex').slice(0,16);
}
/** 지금 커뮤니티에 있는 기기들 중 그 참조가 가리키는 endpointId. 없으면 `null`. */
export function resolveCommunityDeviceRef(ref:unknown,devices:readonly {endpointId:string}[]):string|null{
  if(!isCommunityDeviceRef(ref))return null;
  for(const device of devices)if(communityDeviceRef(device.endpointId)===ref)return device.endpointId;
  return null;
}

/** One row per community device, as `community-status` members describe them. */
export interface CommunityDeviceRow {
  endpointId:string;
  deviceId:string;
  displayName:string;
  kind:'ops'|'project';
  lastSeenAt:string|null;
}
/**
 * 커뮤니티 참여자 목록 → **기기 한 대에 한 줄**. 한 기기가 OPS와 프로젝트 끝점을 모두 공개하고
 * 있으면 OPS가 그 기기를 대표한다(제어는 기기 단위다). 자기 기기는 빼고 이름순으로 돌려준다 —
 * 「다른 기기 목록」과 「휴대폰에 보여 줄 목록」이 같은 판정을 쓰게 하기 위해 한 곳에 둔다.
 */
export function communityDeviceRows(members:unknown,selfDeviceId:string):CommunityDeviceRow[]{
  const byDevice=new Map<string,CommunityDeviceRow>();
  for(const row of Array.isArray(members)?members:[]){
    const member=row as Record<string,unknown>;
    if(typeof member.endpointId!=='string'||typeof member.deviceId!=='string'||member.deviceId===selfDeviceId)continue;
    const device:CommunityDeviceRow={endpointId:member.endpointId,deviceId:member.deviceId,
      displayName:typeof member.displayName==='string'&&member.displayName.trim()?member.displayName:member.deviceId,
      kind:member.kind==='project'?'project':'ops',
      lastSeenAt:typeof member.lastSeenAt==='string'?member.lastSeenAt:null};
    const prior=byDevice.get(device.deviceId);
    if(!prior||prior.kind!=='ops'&&device.kind==='ops')byDevice.set(device.deviceId,device);
  }
  return [...byDevice.values()].sort((a,b)=>a.displayName.localeCompare(b.displayName,'ko'));
}
