import React,{useCallback,useEffect,useRef,useState} from 'react';
import {MessageSquare,RefreshCw,Send,Users} from 'lucide-react';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {communityMessageTime,REMOTE_COMMUNITY_HISTORY_LIMIT,REMOTE_COMMUNITY_SEND_LIMIT,mergeRemoteCommunityMessages,type RemoteCommunityDevice,type RemoteCommunityState} from './remoteCommunity';
import {communityDeviceLabel} from './workroomDeviceLabel';

/**
 * 휴대폰에서 보는 커뮤니티 — 1호 Mac 하나에 들어와 있어도 다른 아젠투지들에게 말을 건다.
 *
 * Mac 화면과 역할이 다르다: **입장·나가기는 여기 없다**(Mac의 「아젠투지 설정」에서만 한다). 휴대폰은
 * 이미 들어와 있는 방을 보고, 읽고, 말하고, 다른 기기의 워크룸으로 건너간다.
 */
export interface RemoteCommunityPanelProps {
  /** 이 Mac의 OPS 프로젝트 control id. 없으면 커뮤니티를 쓸 수 없다(권한 범위 밖). */
  opsTargetId?:string;
  visible:boolean;
  online:boolean;
  /** Mac이 `workspace-v1`을 광고하는지. 옛 Mac이면 업데이트 안내만 보인다. */
  available:boolean;
  transport(request:MobileWorkspaceRequest):Promise<MobileWorkspaceResult>;
  /** 다른 아젠투지의 워크룸으로 건너간다. */
  onDriveDevice(device:RemoteCommunityDevice):void;
  /** 워크룸의 「기기」 줄이 같은 목록을 쓰도록 올려 준다. */
  onDevices?(devices:RemoteCommunityDevice[]):void;
}

const POLL_MS=12_000;
const emptyState:RemoteCommunityState={inside:false,roomId:null,unread:0,members:[],devices:[],messages:[],nextSeq:0};

export function RemoteCommunityPanel({opsTargetId,visible,online,available,transport,onDriveDevice,onDevices}:RemoteCommunityPanelProps){
  const [state,setState]=useState<RemoteCommunityState|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [draft,setDraft]=useState('');
  const [notice,setNotice]=useState('');
  // 커서는 ref에 둔다 — 폴링 effect가 커서에 매이면 메시지가 올 때마다 다시 시작한다.
  const cursor=useRef(0);
  // 부모가 인라인 람다를 넘겨도 폴링이 다시 시작되지 않게 ref로 고정한다.
  const report=useRef(onDevices);report.current=onDevices;

  const call=useCallback(async(action:'community.status'|'community.read'|'community.send',extra:Record<string,unknown>={})=>{
    if(!opsTargetId)throw new Error('이 기기에 아젠투지 총괄(OPS) 프로젝트가 허용되지 않았습니다. Mac에서 범위를 허용하세요.');
    const result=await transport({operation:'workspace',requestId:crypto.randomUUID(),targetId:opsTargetId,
      workspace:{action,...extra}} as MobileWorkspaceRequest);
    const community=result.community??emptyState;
    // ⚠️ 응답의 messages는 **커서 뒤의 새 것**뿐이다. 그대로 덮어쓰면 따라잡은 뒤의 폴링 한 번에
    // 화면이 비어 「메시지가 사라졌다」가 된다. 그래서 가진 것에 더하고 최근 몇 건만 남긴다.
    setState(prior=>({...community,messages:mergeRemoteCommunityMessages(prior?.messages??[],community.messages,REMOTE_COMMUNITY_HISTORY_LIMIT)}));
    report.current?.(community.devices);
    if(community.nextSeq>cursor.current)cursor.current=community.nextSeq;
    return community;
  },[opsTargetId,transport]);

  // A background read is not «busy»: holding the send button for every 12s relay round trip made a tap do
  // nothing (2026-10-06 review). Reads only skip overlapping themselves.
  const reading=useRef(false);
  const refresh=useCallback((action:'community.status'|'community.read'='community.read')=>{
    if(reading.current)return Promise.resolve();
    reading.current=true;
    return call(action,action==='community.read'?{afterSeq:cursor.current}:{})
      .then(()=>setError(''))
      .catch((e:unknown)=>setError(e instanceof Error?e.message:'커뮤니티를 확인하지 못했습니다.'))
      .finally(()=>{reading.current=false;});
  },[call]);

  // 한글 조합 중에는 폴링을 쉬게 한다 — 조합하는 동안 커서 아래에서 목록이 바뀌는 것 자체가 방해다
  // (VOC 2026-10-05, 맥 대화창과 같은 규칙).
  const composing=useRef(false);
  useEffect(()=>{
    if(!visible||!online||!available||!opsTargetId)return;
    void refresh('community.read');
    const timer=setInterval(()=>{if(!composing.current)void refresh('community.read');},POLL_MS);
    return ()=>clearInterval(timer);
  },[visible,online,available,opsTargetId,refresh]);

  const draftBytes=new TextEncoder().encode(draft).length;
  const send=()=>{
    const text=draft.trim();
    if(!text||busy)return;
    setBusy(true);setNotice('');
    call('community.send',{text,afterSeq:cursor.current})
      .then(()=>{setDraft('');setError('');setNotice('커뮤니티에 보냈습니다. 각 아젠투지의 총괄 AI가 받습니다.');})
      .catch((e:unknown)=>setError(e instanceof Error?e.message:'메시지를 보내지 못했습니다.'))
      .finally(()=>setBusy(false));
  };

  if(!available)return <section className="remote-panel remote-community" data-testid="remote-community-update-required">
    <h2><Users aria-hidden="true"/>커뮤니티</h2>
    <p className="remote-community-empty">Mac 앱 업데이트 필요 — 연결한 Mac 앱을 업데이트하면 휴대폰에서도 커뮤니티를 쓸 수 있습니다.</p>
  </section>;
  if(!opsTargetId)return <section className="remote-panel remote-community" data-testid="remote-community-ops-missing">
    <h2><Users aria-hidden="true"/>커뮤니티</h2>
    <p className="remote-community-empty">이 기기에 아젠투지 총괄(OPS) 프로젝트가 허용되지 않았습니다. Mac의 「외부 인터넷 원격제어」에서 범위를 허용하면 다른 아젠투지들과 주고받을 수 있습니다.</p>
  </section>;

  const inside=state?.inside===true;
  const others=(state?.members??[]).filter(member=>!member.self).length;
  return <section className="remote-panel remote-community" data-testid="remote-community">
    <h2><Users aria-hidden="true"/>커뮤니티{state&&state.unread>0?<span className="remote-community-unread" data-testid="remote-community-unread">읽지 않음 {state.unread}</span>:null}</h2>
    <p className="remote-community-state" data-testid="remote-community-state">
      {state===null?'커뮤니티 상태를 확인하고 있습니다…'
        :inside?`이 Mac이 참여 중 · 함께 있는 대상 ${others}개`
        :state.roomId?'이 Mac이 아직 커뮤니티에 들어가지 않았습니다. Mac의 「기기 간 대화」(아젠투지 설정 옆)에서 입장하세요.'
        :'커뮤니티가 아직 없습니다. Mac의 「기기 간 대화」(아젠투지 설정 옆)에서 입장하면 단체방이 만들어집니다.'}
    </p>
    {error&&<p className="remote-community-error" role="alert" data-testid="remote-community-error">{error}</p>}
    {notice&&<p className="remote-community-notice" data-testid="remote-community-notice">{notice}</p>}
    {inside&&<>
      <div className="remote-community-messages" data-testid="remote-community-messages">
        {(state?.messages??[]).length===0
          ?<p className="remote-community-empty">새 메시지가 없습니다.</p>
          :(state?.messages??[]).map(message=><article key={message.seq} className={message.self?'remote-community-message remote-community-message--self':'remote-community-message'}>
            <header>{message.self?'이 Mac':message.from}<span>{communityMessageTime(message.at)}</span></header>
            <p>{message.text}{message.truncated?' …':''}</p>
          </article>)}
      </div>
      <div className="remote-community-compose">
        <textarea data-testid="remote-community-draft" rows={2} value={draft}
          placeholder="다른 아젠투지들에게 보낼 내용"
          onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
          onChange={event=>setDraft(event.target.value)}/>
        {/* The limit is bytes, not characters (Korean is 3 bytes each) — the same rule as the Mac panel. */}
        {draftBytes>REMOTE_COMMUNITY_SEND_LIMIT*0.8&&<small className={draftBytes>REMOTE_COMMUNITY_SEND_LIMIT?'remote-community-error':undefined} data-testid="remote-community-bytes">{draftBytes.toLocaleString()} / {REMOTE_COMMUNITY_SEND_LIMIT.toLocaleString()}바이트</small>}
        <button type="button" className="remote-primary" data-testid="remote-community-send" disabled={busy||!draft.trim()||draftBytes>REMOTE_COMMUNITY_SEND_LIMIT} onClick={send}><Send aria-hidden="true"/>보내기</button>
      </div>
      <div className="remote-community-devices" data-testid="remote-community-devices">
        <h3>다른 아젠투지 제어</h3>
        {(state?.devices??[]).length===0
          ?<p className="remote-community-empty">지금 커뮤니티에 다른 기기가 없습니다. 그 Mac에서도 입장하면 여기에 보입니다.</p>
          :(state?.devices??[]).map(device=><button key={device.ref} type="button" className="remote-secondary"
            data-testid={'remote-community-drive-'+device.ref} onClick={()=>onDriveDevice(device)}>
            <MessageSquare aria-hidden="true"/>{communityDeviceLabel(device.name)}의 워크룸 열기</button>)}
      </div>
    </>}
    <button type="button" className="remote-secondary remote-community-refresh" data-testid="remote-community-refresh"
      disabled={busy} onClick={()=>{void refresh('community.read');}}><RefreshCw aria-hidden="true"/>새로고침</button>
  </section>;
}
