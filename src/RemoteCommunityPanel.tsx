import React,{useCallback,useEffect,useRef,useState} from 'react';
import {MessageSquare,RefreshCw,Send,Users} from 'lucide-react';
import type {MobileWorkspaceRequest,MobileWorkspaceResult} from './mobileWorkspaceProtocol';
import {communityMessageTime,REMOTE_COMMUNITY_HISTORY_LIMIT,REMOTE_COMMUNITY_SEND_LIMIT,mergeRemoteCommunityMessages,type RemoteCommunityDevice,type RemoteCommunityState} from './remoteCommunity';
import {communityDeviceLabel} from './workroomDeviceLabel';
import {COMMUNITY_KIND_LABEL,communityMessagePreview} from './communityMessageView';

/**
 * 휴대폰에서 보는 아젠투지 단톡방 — 1호 Mac 하나에 들어와 있어도 다른 아젠투지들에게 말을 건다.
 *
 * Mac 화면과 역할이 다르다: **입장·나가기는 여기 없다**(Mac의 「아젠투지 설정」에서만 한다). 휴대폰은
 * 이미 들어와 있는 방을 보고, 읽고, 말하고, 다른 기기의 워크룸으로 건너간다.
 */
export interface RemoteCommunityPanelProps {
  /** 이 Mac의 OPS 프로젝트 control id. 없으면 아젠투지 단톡방를 쓸 수 없다(권한 범위 밖). */
  opsTargetId?:string;
  visible:boolean;
  online:boolean;
  /**
   * Mac이 `workspace-v1`을 광고하는지. 옛 Mac이면 업데이트 안내만 보인다.
   * `null` — 아직 모른다(연결 전·기능 확인 전·세션이 닫힌 뒤). 모르는 것을 「업데이트 필요」로 말하지 않는다.
   */
  available:boolean|null;
  transport(request:MobileWorkspaceRequest):Promise<MobileWorkspaceResult>;
  /** 다른 아젠투지의 워크룸으로 건너간다. */
  onDriveDevice(device:RemoteCommunityDevice):void;
  /** 워크룸의 「기기」 줄이 같은 목록을 쓰도록 올려 준다. */
  onDevices?(devices:RemoteCommunityDevice[]):void;
}

const POLL_MS=12_000;

/**
 * 보낸 뒤의 한 줄. 메시지는 방에 남을 뿐 어느 AI에게도 저절로 들어가지 않는다 — 받는 쪽은 읽지 않음으로 보고,
 * 사람이 AI에게 읽어 달라고 할 때 가져간다(CLAUDE.md 「받은 메시지를 CLI에 자동 입력하지 않는다」). 예전 문구
 * 「각 아젠투지의 총괄 AI가 받습니다」는 일어나지 않는 전달을 약속했다(2026-10-16 감사).
 */
export const REMOTE_COMMUNITY_SENT_NOTICE='아젠투지 단톡방에 남겼습니다. 다른 아젠투지는 읽지 않은 메시지로 보고, AI에게 「아젠투지 단톡방 메시지 읽어줘」라고 하면 가져갑니다.';
const emptyState:RemoteCommunityState={inside:false,roomId:null,unread:0,members:[],devices:[],messages:[],nextSeq:0};

export function RemoteCommunityPanel({opsTargetId,visible,online,available,transport,onDriveDevice,onDevices}:RemoteCommunityPanelProps){
  const [state,setState]=useState<RemoteCommunityState|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [draft,setDraft]=useState('');
  const [notice,setNotice]=useState('');
  /** Messages opened with 「전체 보기」, by seq. */
  const [expanded,setExpanded]=useState<ReadonlySet<number>>(()=>new Set());
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
      .catch((e:unknown)=>setError(e instanceof Error?e.message:'아젠투지 단톡방을 확인하지 못했습니다.'))
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
      .then(()=>{setDraft('');setError('');setNotice(REMOTE_COMMUNITY_SENT_NOTICE);})
      .catch((e:unknown)=>setError(e instanceof Error?e.message:'메시지를 보내지 못했습니다.'))
      .finally(()=>setBusy(false));
  };

  // 연결이 먼저다: Mac이 없거나 끊긴 동안의 「업데이트 필요」는 연결하지도 않은 Mac을 고치라는 말이었다(2026-10-16 감사).
  if(!online)return <section className="remote-panel remote-community" data-testid="remote-community-offline">
    <h2><Users aria-hidden="true"/>아젠투지 단톡방</h2>
    <p className="remote-community-empty">Mac에 연결하면 아젠투지 단톡방을 볼 수 있습니다.</p>
  </section>;
  if(available===null)return <section className="remote-panel remote-community" data-testid="remote-community-checking" role="status">
    <h2><Users aria-hidden="true"/>아젠투지 단톡방</h2>
    <p className="remote-community-empty">연결한 Mac이 아젠투지 단톡방을 지원하는지 확인하고 있습니다…</p>
  </section>;
  if(!available)return <section className="remote-panel remote-community" data-testid="remote-community-update-required">
    <h2><Users aria-hidden="true"/>아젠투지 단톡방</h2>
    <p className="remote-community-empty">Mac 앱 업데이트 필요 — 연결한 Mac 앱을 업데이트하면 휴대폰에서도 아젠투지 단톡방을 쓸 수 있습니다.</p>
  </section>;
  if(!opsTargetId)return <section className="remote-panel remote-community" data-testid="remote-community-ops-missing">
    <h2><Users aria-hidden="true"/>아젠투지 단톡방</h2>
    <p className="remote-community-empty">이 기기에 아젠투지 총괄(OPS) 프로젝트가 허용되지 않았습니다. Mac의 「외부 인터넷 원격제어」에서 범위를 허용하면 다른 아젠투지들과 주고받을 수 있습니다.</p>
  </section>;

  const inside=state?.inside===true;
  const others=(state?.members??[]).filter(member=>!member.self).length;
  return <section className="remote-panel remote-community" data-testid="remote-community">
    <h2><Users aria-hidden="true"/>아젠투지 단톡방{state&&state.unread>0?<span className="remote-community-unread" data-testid="remote-community-unread">읽지 않음 {state.unread}</span>:null}</h2>
    <p className="remote-community-state" data-testid="remote-community-state">
      {state===null?'아젠투지 단톡방 상태를 확인하고 있습니다…'
        :inside?`이 Mac이 참여 중 · 함께 있는 대상 ${others}개`
        :state.roomId?'이 Mac이 아직 아젠투지 단톡방에 들어가지 않았습니다. Mac의 「기기 간 대화」(아젠투지 설정 옆)에서 입장하세요.'
        :'아젠투지 단톡방이 아직 없습니다. Mac의 「기기 간 대화」(아젠투지 설정 옆)에서 입장하면 단체방이 만들어집니다.'}
    </p>
    {error&&<p className="remote-community-error" role="alert" data-testid="remote-community-error">{error}</p>}
    {notice&&<p className="remote-community-notice" data-testid="remote-community-notice">{notice}</p>}
    {inside&&<>
      <div className="remote-community-messages" data-testid="remote-community-messages">
        {(state?.messages??[]).length===0
          ?<p className="remote-community-empty">새 메시지가 없습니다.</p>
          :(state?.messages??[]).map(message=>{
            const {preview,folded}=communityMessagePreview(message.text),whole=!folded||expanded.has(message.seq),label=COMMUNITY_KIND_LABEL[message.kind];
            return <article key={message.seq} className={message.self?'remote-community-message remote-community-message--self':'remote-community-message'}>
              <header>{message.self?'이 Mac':message.from}{label&&<em className="remote-community-kind">{label}</em>}<span>{communityMessageTime(message.at)}</span></header>
              <p>{whole?message.text:preview}{whole&&message.truncated?' …':''}</p>
              {folded&&<button type="button" className="remote-community-more" aria-expanded={whole} data-testid="remote-community-more"
                onClick={()=>setExpanded(prior=>{const next=new Set(prior);if(!next.delete(message.seq))next.add(message.seq);return next;})}>{whole?'접기':'전체 보기'}</button>}
            </article>;})}
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
          ?<p className="remote-community-empty">지금 아젠투지 단톡방에 다른 기기가 없습니다. 그 Mac에서도 입장하면 여기에 보입니다.</p>
          :(state?.devices??[]).map(device=><button key={device.ref} type="button" className="remote-secondary"
            data-testid={'remote-community-drive-'+device.ref} onClick={()=>onDriveDevice(device)}>
            <MessageSquare aria-hidden="true"/>{communityDeviceLabel(device.name)}의 워크룸 열기</button>)}
      </div>
    </>}
    <button type="button" className="remote-secondary remote-community-refresh" data-testid="remote-community-refresh"
      disabled={busy} onClick={()=>{void refresh('community.read');}}><RefreshCw aria-hidden="true"/>새로고침</button>
  </section>;
}
