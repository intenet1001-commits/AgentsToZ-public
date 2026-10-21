/**
 * What 「기기 간 연결(30일)」 shows: one row per reachable peer endpoint with this device's pairing
 * state for that exact couple.
 *
 * A pairing is mutual, so «연결됨» is never one side's opinion: `waiting-peer` and `waiting-me` are
 * different states and the row says which side still has to accept. An expired pairing reads as
 * expired rather than quietly disappearing, because the fix is to accept again, not to re-pair blind.
 */
export type AgentDialoguePairingState='none'|'waiting-peer'|'waiting-me'|'active'|'expired';

export interface AgentDialoguePairingPeer {
  endpointId:string;
  displayName?:string;
  kind?:'ops'|'project';
  deviceId?:string;
}

export interface AgentDialoguePairingRecord {
  peerEndpointId?:string;
  state?:string;
  acceptedByMe?:boolean;
  acceptedByPeer?:boolean;
  expiresAt?:string|null;
}

export interface AgentDialoguePairingRow {
  endpointId:string;
  displayName:string;
  kind:'ops'|'project';
  deviceId:string;
  state:AgentDialoguePairingState;
  expiresAt:string|null;
}

const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();

export function agentDialoguePairingState(record:AgentDialoguePairingRecord|undefined):AgentDialoguePairingState{
  if(!record)return 'none';
  if(record.state==='expired')return 'expired';
  if(record.state==='active')return 'active';
  if(record.acceptedByMe===true&&record.acceptedByPeer!==true)return 'waiting-peer';
  if(record.acceptedByMe!==true&&record.acceptedByPeer===true)return 'waiting-me';
  return 'none';
}

export function agentDialoguePairingRows({peers,pairings,search}:{
  peers:readonly AgentDialoguePairingPeer[]|null;
  pairings:readonly AgentDialoguePairingRecord[]|null;
  search?:string;
}):AgentDialoguePairingRow[]{
  const byPeer=new Map<string,AgentDialoguePairingRecord>();
  for(const record of pairings??[]){
    const id=record.peerEndpointId;
    if(typeof id==='string'&&!byPeer.has(id))byPeer.set(id,record);
  }
  const rows:AgentDialoguePairingRow[]=[];
  const seen=new Set<string>();
  for(const peer of peers??[]){
    if(typeof peer.endpointId!=='string'||seen.has(peer.endpointId))continue;
    seen.add(peer.endpointId);
    const record=byPeer.get(peer.endpointId);
    rows.push({
      endpointId:peer.endpointId,
      displayName:peer.displayName||peer.endpointId,
      kind:peer.kind==='ops'?'ops':'project',
      deviceId:peer.deviceId??'',
      state:agentDialoguePairingState(record),
      expiresAt:record?.expiresAt??null,
    });
  }
  const needle=normalize(search??'');
  return needle?rows.filter(row=>normalize(row.displayName).includes(needle)):rows;
}

/** 「활성 N」 counts the couples that actually carry the 30 days, across the unfiltered rows. */
export function agentDialoguePairingSummary(rows:readonly AgentDialoguePairingRow[]):{
  active:number;waiting:number;total:number;
}{
  let active=0,waiting=0;
  for(const row of rows){
    if(row.state==='active')active+=1;
    else if(row.state==='waiting-me'||row.state==='waiting-peer')waiting+=1;
  }
  return {active,waiting,total:rows.length};
}
