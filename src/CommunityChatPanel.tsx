import React,{memo,useCallback,useEffect,useRef,useState} from 'react';
import {Send,Users} from 'lucide-react';
import {manageAgentDialogue} from './AgentDialoguePanel';
import {LOCAL_COMMUNITY_MESSAGE_LIMIT,LOCAL_COMMUNITY_TEXT_LIMIT,REMOTE_COMMUNITY_SEND_LIMIT,mergeRemoteCommunityMessages,normalizeRemoteCommunityState,type RemoteCommunityState} from './remoteCommunity';
/** 서버가 맥 한도로 내보내므로 검사기도 같은 한도로 읽어야 한다 — 기본값(휴대폰)이면 통째로 거절한다. */
const LOCAL_LIMITS={messages:LOCAL_COMMUNITY_MESSAGE_LIMIT,text:LOCAL_COMMUNITY_TEXT_LIMIT};

/**
 * 맥의 커뮤니티 대화창 (2026-10-05).
 *
 * 폰에만 대화창이 있어서(`RemoteCommunityPanel`) 맥에서는 입장·멤버 확인만 되고 **주고받는 일은 AI에게
 * 시켜야** 했다. 같은 일을 맥 화면에서 직접 하도록 워크룸의 「기기」 줄 바로 아래에 둔다.
 *
 * ⚠️ **접혀 있는 동안은 아무 것도 두드리지 않는다.** 읽지 않음 개수는 워크룸이 이미 15초마다 하는
 * 기기 조회가 싣고 오고(`controlDevices`가 부르는 `community-status`의 덤), 메시지 조회는 **펼친 뒤에만**
 * 12초 주기로 돈다. 워크룸은 이 앱에서 가장 빽빽한 화면이라, 읽을 것이 없을 때 한 줄만 차지해야 한다.
 *
 * 서버가 폰과 **같은 모양**(`remoteCommunityState`)으로 내보내므로 정규화·합치기는 폰 것을 그대로 쓴다.
 */
const POLL_MS=12_000;

/**
 * ⚠️ 입력칸은 **따로 떼어 memo**한다. 메시지 폴링이 상태를 갈아끼울 때마다 입력칸까지 다시 그려지면,
 * 한글 IME가 조합 중인 글자를 들고 있는 동안 그 subtree가 건드려진다(VOC 2026-10-05 「타이핑이 잘 안 된다」).
 * 초안은 여기 안에서만 산다 — 밖에서 값을 내려 주지 않으므로 조합 중 값이 뒤집힐 길이 없다.
 * 조합 중에는 부모의 읽기도 쉬게 한다(`onComposing`).
 */
const CommunityCompose=memo(function CommunityCompose({busy,onSend,onComposing}:{
  busy:boolean;onSend:(text:string)=>Promise<boolean>;onComposing:(active:boolean)=>void;
}){
  const [draft,setDraft]=useState('');
  const field=useRef<HTMLTextAreaElement|null>(null);
  // ⚠️ **보낸 뒤에만** 비운다. 먼저 비우면 실패했을 때 쓰던 글이 사라진다.
  const submit=()=>{const text=draft.trim();if(!text||busy)return;void onSend(text).then(sent=>{if(sent)setDraft('');});};
  const bytes=new TextEncoder().encode(draft).length;
  const over=bytes>REMOTE_COMMUNITY_SEND_LIMIT;
  return <div className="ai-terminal-community-compose">
    <textarea ref={field} aria-label="커뮤니티에 보낼 내용" data-testid="workroom-community-draft" rows={2}
      placeholder="다른 아젠투지들에게 보낼 내용 · 각 아젠투지의 총괄 AI가 받습니다"
      value={draft} disabled={busy}
      onCompositionStart={()=>onComposing(true)} onCompositionEnd={()=>onComposing(false)}
      onChange={event=>setDraft(event.target.value)}/>
    <button type="button" className="ai-terminal-btn ai-terminal-start" data-testid="workroom-community-send"
      disabled={busy||!draft.trim()||over} onClick={submit}><Send size={13}/>{busy?'보내는 중…':'보내기'}</button>
    {/* 글자 수가 아니라 **바이트**다 — 한글은 글자당 3바이트라 2,000자로 막으면 서버가 먼저 거절한다. */}
    {bytes>REMOTE_COMMUNITY_SEND_LIMIT*0.8&&<span className={`ai-terminal-hint${over?' ai-terminal-hint--error':''}`}
      data-testid="workroom-community-bytes">{bytes.toLocaleString('ko-KR')} / {REMOTE_COMMUNITY_SEND_LIMIT.toLocaleString('ko-KR')}바이트</span>}
  </div>;
});

export function CommunityChatPanel({unread,label}:{unread:number;label:string}){
  const [open,setOpen]=useState(false);
  const [state,setState]=useState<RemoteCommunityState|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const cursor=useRef(0);
  const flight=useRef(false);
  // 한글 조합 중에는 목록을 갈아끼우지 않는다 — 커서 아래에서 화면이 바뀌는 것 자체가 방해다.
  const composing=useRef(false);
  // 커서는 **앞으로만** 간다. 뒤로 가면 이미 본 줄을 다시 받고, 0으로 떨어지면 가장 오래된 줄이 돌아온다.
  const advance=useCallback((seq:number)=>{if(Number.isSafeInteger(seq)&&seq>cursor.current)cursor.current=seq;},[]);
  const onComposing=useCallback((active:boolean)=>{composing.current=active;},[]);

  const read=useCallback(async()=>{
    if(flight.current||composing.current)return;
    flight.current=true;
    try{
      const result=await manageAgentDialogue('community-read',cursor.current?{afterSeq:cursor.current}:{});
      // 모양이 어긋나면 던진다 — 조용히 빈 화면을 보여 주는 쪽이 더 나쁘다.
      const next=normalizeRemoteCommunityState((result as {community?:unknown}).community,LOCAL_LIMITS);
      setState(prior=>{
        const merged=prior?mergeRemoteCommunityMessages(prior.messages,next.messages,LOCAL_COMMUNITY_MESSAGE_LIMIT):next.messages;
        return {...next,messages:merged};
      });
      advance(next.nextSeq);
      setError('');
    }catch(readError){setError(readError instanceof Error?readError.message:'커뮤니티 메시지를 받지 못했습니다.');}
    finally{flight.current=false;}
  },[]);

  // 펼친 동안에만 돈다. 접으면 타이머가 사라지고 커서는 유지되므로 다시 펼칠 때 이어 읽는다.
  useEffect(()=>{
    if(!open)return;
    void read();
    const timer=setInterval(()=>{void read();},POLL_MS);
    return ()=>clearInterval(timer);
  },[open,read]);

  const send=useCallback(async(text:string):Promise<boolean>=>{
    if(!text)return false;
    setBusy(true);setError('');
    try{
      // ⚠️ 커서를 **함께** 보낸다. 호스트는 커서를 준 `send`에만 메시지를 돌려주므로(agentDialogueHost
      // 의 `cursorGiven`), 빼먹으면 방금 보낸 내 말이 다음 폴링(12초)까지 화면에 없다.
      const result=await manageAgentDialogue('community-send',{text,afterSeq:cursor.current,requestId:crypto.randomUUID()});
      const next=normalizeRemoteCommunityState((result as {community?:unknown}).community,LOCAL_LIMITS);
      setState(prior=>({...next,messages:prior?mergeRemoteCommunityMessages(prior.messages,next.messages,LOCAL_COMMUNITY_MESSAGE_LIMIT):next.messages}));
      advance(next.nextSeq);
      return true;
    }catch(sendError){setError(sendError instanceof Error?sendError.message:'커뮤니티에 보내지 못했습니다.');return false;}
    finally{setBusy(false);}
  },[]);

  // ⚠️ 인라인 람다를 넘기면 memo가 깨져 폴링마다 입력칸이 다시 그려진다 — 이 컴포넌트를 떼어 놓은 이유가 사라진다.
  const handleSend=useCallback((text:string)=>send(text),[send]);
  const waiting=unread>0?`읽지 않음 ${unread}개`:null;
  return <div className="ai-terminal-community" data-testid="workroom-community">
    <button type="button" className="ai-terminal-btn ai-terminal-community-toggle" data-testid="workroom-community-toggle"
      aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
      <Users size={13}/>커뮤니티 · {label}{waiting?` · ${waiting}`:''}
    </button>
    {!open&&!!waiting&&<span className="ai-terminal-hint" data-testid="workroom-community-unread">눌러서 읽고 답할 수 있습니다.</span>}
    {open&&<div className="ai-terminal-community-body">
      {error&&<p className="ai-terminal-hint ai-terminal-hint--error" role="alert" data-testid="workroom-community-error">{error}</p>}
      {!state&&!error&&<p className="ai-terminal-hint" data-testid="workroom-community-loading">커뮤니티 대화를 받고 있습니다…</p>}
      {state&&!state.inside&&<p className="ai-terminal-hint" data-testid="workroom-community-outside">이 Mac이 커뮤니티에 입장하지 않았습니다. 「기기 간 대화」(아젠투지 설정 옆)에서 입장하세요.</p>}
      {state?.inside&&<>
        <div className="ai-terminal-community-log" data-testid="workroom-community-log">
          {state.messages.length===0
            ?<p className="ai-terminal-hint">아직 받은 대화가 없습니다. 입장 전에 지나간 대화는 보이지 않습니다.</p>
            :state.messages.map(message=><div key={message.seq} className={`ai-terminal-community-row${message.self?' ai-terminal-community-row--mine':''}`}>
              <span className="ai-terminal-community-from">{message.self?'이 Mac':message.from}</span>
              <span className="ai-terminal-community-text">{message.text}{message.truncated?' …':''}</span>
            </div>)}
        </div>
        <CommunityCompose busy={busy} onSend={handleSend} onComposing={onComposing}/>
      </>}
    </div>}
  </div>;
}
