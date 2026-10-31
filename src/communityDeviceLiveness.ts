/**
 * Whether another Mac in the community still answers. Every enabled dialogue endpoint beats once per
 * AGENT_DIALOGUE_HEARTBEAT_MS (agentDialogueHost.maintenance, on the api-server timer), which is what `lastSeenAt` is.
 * A device whose last beat is older than three of those has missed at least two, and the Workroom 「기기」 tab says
 * 「응답 없음 · 마지막 …」. It stays selectable: a sleeping Mac wakes and answers, and each request's own receipt still
 * says what happened. Unknown or unreadable `lastSeenAt` is not called stale. Browser-safe: no node imports.
 */
export const AGENT_DIALOGUE_HEARTBEAT_MS=10*60_000;
export const COMMUNITY_DEVICE_STALE_MS=3*AGENT_DIALOGUE_HEARTBEAT_MS;

export function communityDeviceStale(lastSeenAt:string|null|undefined,now:number):boolean{
  if(typeof lastSeenAt!=='string')return false;
  const seen=Date.parse(lastSeenAt);
  return Number.isFinite(seen)&&now-seen>COMMUNITY_DEVICE_STALE_MS;
}

/** 「마지막 42분 전」: relative, so it reads the same in every time zone and needs no date formatting. */
export function communityDeviceLastSeen(lastSeenAt:string,now:number):string{
  const minutes=Math.max(0,Math.floor((now-Date.parse(lastSeenAt))/60_000));
  const ago=minutes<60?`${minutes}분 전`:minutes<48*60?`${Math.floor(minutes/60)}시간 전`:`${Math.floor(minutes/(24*60))}일 전`;
  return `마지막 ${ago}`;
}

/** Each stale device's 「마지막 …」 by endpointId; a device that answers has no entry. */
export function communityStaleDevices(devices:readonly {endpointId:string;lastSeenAt:string|null}[],now:number):Record<string,string>{
  const lastSeen:Record<string,string>={};
  for(const device of devices)if(communityDeviceStale(device.lastSeenAt,now))lastSeen[device.endpointId]=communityDeviceLastSeen(device.lastSeenAt!,now);
  return lastSeen;
}
