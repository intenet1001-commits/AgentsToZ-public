/**
 * 커뮤니티 — 이 운영 프로필의 단체방 하나.
 *
 * 「누가 누구를 부른다」가 아니라 **각자 한 번 입장해 있으면 상호 통신**이고, 나가지 않는 한 계속
 * 남는다. 그래서 쌍마다 수락하던 것(기기 3대면 3쌍, 4대면 6쌍)이 입장 한 번으로 줄고 만료 개념도
 * 없다. 화면 판정은 이 파일 한 곳이다.
 */
export interface AgentDialogueCommunityMember {
  endpointId:string;
  displayName?:string;
  kind?:'ops'|'project';
  deviceId?:string;
  participantId?:string;
  joinedAt?:string|null;
  lastSeenAt?:string|null;
}

export interface AgentDialogueCommunityStatus {
  roomId?:string|null;
  inside?:boolean;
  participantId?:string|null;
  members?:readonly AgentDialogueCommunityMember[]|null;
  /** 이 대상 앞으로 와 있는 읽지 않은 메시지. 내 메시지와 남에게만 보낸 것은 세지 않는다. */
  unread?:number|null;
  lastMessageAt?:string|null;
}

export type AgentDialogueCommunityState='unknown'|'empty'|'outside'|'inside';

export interface AgentDialogueCommunityView {
  state:AgentDialogueCommunityState;
  /** 기다리는 메시지 수. 받은 쪽에 아무 신호가 없어서 커뮤니티가 한쪽으로만 흘렀다. */
  unread:number;
  waiting:string|null;
  /** 다른 기기에서 들어와 있는 참여자(나를 뺀 수). */
  others:number;
  members:AgentDialogueCommunityMember[];
  headline:string;
  detail:string;
  actionLabel:string;
  /** 누르면 입장할지(`join`) 나갈지(`leave`). 조회 전에는 누를 수 없다. */
  action:'join'|'leave'|null;
}

/** 조회 전(`null`)을 「입장 안 함」으로 단정하지 않는다 — 그건 아직 모르는 상태다. */
export function agentDialogueCommunityView(
  status:AgentDialogueCommunityStatus|null|undefined,
  myEndpointId?:string|null,
):AgentDialogueCommunityView{
  if(status===null||status===undefined)return {
    state:'unknown',unread:0,waiting:null,others:0,members:[],
    headline:'커뮤니티 상태 확인 중…',
    detail:'이 기기가 단체방에 들어와 있는지 확인하고 있습니다.',
    actionLabel:'커뮤니티 입장',action:null,
  };
  const members=(status.members??[]).filter((member):member is AgentDialogueCommunityMember=>
    !!member&&typeof member.endpointId==='string');
  const others=members.filter(member=>member.endpointId!==myEndpointId).length;
  const unread=typeof status.unread==='number'&&Number.isFinite(status.unread)&&status.unread>0
    ?Math.floor(status.unread):0;
  const waiting=unread>0
    ?`읽지 않은 메시지 ${unread}개가 기다립니다. AI에게 「커뮤니티 메시지 읽어줘」라고 하면 가져옵니다.`
    :null;
  if(status.inside===true)return {
    state:'inside',unread,waiting,others,members,
    headline:`커뮤니티 참여 중 · 함께 있는 대상 ${others}개${unread>0?` · 읽지 않음 ${unread}개`:''}`,
    detail:others>0
      ?'지금 들어와 있는 대상끼리 초대 없이 바로 주고받습니다. 나가지 않는 한 계속 참여합니다.'
      :'아직 혼자입니다. 다른 기기에서도 입장하면 그때부터 서로 주고받습니다.',
    actionLabel:'커뮤니티 나가기',action:'leave',
  };
  if(!status.roomId)return {
    state:'empty',unread:0,waiting:null,others:0,members:[],
    headline:'커뮤니티가 아직 없습니다',
    detail:'먼저 입장하면 이 운영 프로필의 단체방이 만들어집니다. 다른 기기도 각자 입장하면 바로 서로 주고받습니다.',
    actionLabel:'커뮤니티 입장',action:'join',
  };
  return {
    state:'outside',unread:0,waiting:null,others,members,
    headline:`커뮤니티 밖 · 들어와 있는 대상 ${others}개`,
    detail:'입장하면 그 뒤에 오는 메시지를 받습니다. 입장 전에 지나간 대화는 보이지 않습니다.',
    actionLabel:'커뮤니티 입장',action:'join',
  };
}

export function agentDialogueCommunityMemberLabel(member:AgentDialogueCommunityMember,myEndpointId?:string|null):string{
  const name=member.displayName||member.endpointId;
  return member.endpointId===myEndpointId?`${name} · 이 기기`:name;
}
