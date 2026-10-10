import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import type {AiTerminalTransport} from './aiTerminalClient';

/**
 * The parts of one submission cut for the wire (splitTerminalSubmission / splitTerminalInput). Once one part is refused
 * or lost, the rest are never sent: sent anyway they would type the start and the end without the middle — a different
 * command, Enter included. The queue went on after a failed part, and the phone's queue even puts a read between parts
 * (review 2026-10-09). Kept off the wire: it only travels with the queued request on this side.
 */
export interface TerminalSubmissionGroup {failed:boolean}
export const terminalSubmissionGroup=():TerminalSubmissionGroup=>({failed:false});
type PendingRequest = {
  request: Omit<AiTerminalRequest,'requestId'>;
  resolve: (response:AiTerminalResponse)=>void;
  reject: (reason:unknown)=>void;
  cancelled?:boolean;
  group?:TerminalSubmissionGroup;
};
/** Shown once, on the first failed part: the parts before it did reach the CLI, and a timed-out part may have too. */
export const PARTIAL_SUBMISSION_NOTICE='입력 일부만 전달됐을 수 있습니다 — CLI 입력칸에 남은 글을 지운 뒤 다시 보내세요.';
/** The parts and inputs dropped after that failure stay quiet: one message, the real cause first. */
const partAborted=()=>Object.assign(new Error(PARTIAL_SUBMISSION_NOTICE),{partOfFailedSubmission:true});
const withPartialNotice=(error:unknown)=>{const message=error instanceof Error?error.message:String(error);return new Error(message.includes(PARTIAL_SUBMISSION_NOTICE)?message:`${message} ${PARTIAL_SUBMISSION_NOTICE}`);};
/**
 * A part the remote controller kept on the phone (REMOTE_CONTROL_REQUEST_UNSENT, remoteControlRelayController.ts) is
 * not lost: that exact envelope goes out once when the screen reconnects. 「다시 보내세요」 then typed the command a
 * second time (review 2026-10-10). Compared by string so this module does not pull in the relay controller.
 */
const REQUEST_UNSENT_CODE='REMOTE_CONTROL_REQUEST_UNSENT';
const isHeldOnPhone=(error:unknown)=>!!error&&typeof error==='object'&&(error as {code?:unknown}).code===REQUEST_UNSENT_CODE;
/** The held part is not the last one: it arrives later, the parts after it never do. */
export const HELD_PART_NOTICE='휴대폰 네트워크가 끊겨 긴 입력의 한 조각을 휴대폰에 보관했습니다 — 이 화면이 다시 연결되면 그 조각까지만 한 번 보내고, 뒤의 조각은 보내지 않았습니다. 다시 연결된 뒤 CLI 입력칸을 확인하고 남은 글을 지운 다음 보내세요.';
type LocalQueue={pending:PendingRequest[];draining:boolean};
export const TERMINAL_REQUESTER_MAX_PENDING = 256;
const REMOTE_REQUEST_INTERVAL_MS=140;
// Four writes per five slots can keep up with the panel's 180 ms input batches.
// The read queue receives every fifth slot under sustained writes (transport time aside).
const MAX_WRITES_BEFORE_READ=4;

/** An input acknowledgement can arrive before the CLI has painted its echo.
 * Keep a short, bounded response window instead of inheriting idle backoff. */
export function createTerminalReadCadence(remote:boolean, now=()=>performance.now(), options:{slow?:boolean}={}) {
  let idleReads=0, responsiveUntil=0, activeUntil=0;
  // ⚠️ 다른 아젠투지의 워크룸을 몰 때는 읽기 한 번이 **두 홉**이다(폰→이 Mac→상대 Mac, 상대의 제어
  // 우편함은 유휴 3초·활성 0.6초). 700ms 박자로 읽으면 끝나지 않은 요청 위에 요청이 쌓여 릴레이 줄이
  // 길어지고, 정작 사람이 누른 것이 뒤로 밀린다(2026-10-05 실기). 그래서 느린 박자를 따로 쓴다.
  const base=options.slow?1500:remote?700:120, cap=options.slow?8000:remote?5000:2000;
  // 출력이 아직 오는 중이면 거의 바로 다시 읽는다. 패널은 읽기를 **한 번에 하나만** 보내므로(inFlight)
  // 짧은 간격이 요청을 쌓지 않는다 — 두 홉 왕복(2~3초) 위에 1.5초를 더 얹던 것이 출력이 뭉텅이로 끊겨
  // 보이던 원인이었다(아이폰 실기, 2026-10-07 「끊김현상」).
  const streaming=remote?(options.slow?250:200):base;
  return {
    // 사람이 입력한 뒤 30초는 물러나지 않는다 — AI의 답은 몇 초 뒤에 오는데, 그 사이 박자가 6~8초로
    // 늘어나 있으면 답이 늦게 한꺼번에 보였다.
    wake() {idleReads=0;responsiveUntil=now()+1500;activeUntil=now()+30_000;},
    next(hasOutput:boolean,hasMore:boolean) {
      idleReads=hasOutput?0:Math.min(5,idleReads+1);
      if(hasMore)return 0;
      if(!remote&&now()<responsiveUntil)return 32;
      if(hasOutput)return streaming;
      if(remote&&now()<activeUntil)return base;
      return Math.min(cap,base*2**idleReads);
    },
  };
}

/** Local reads stay independent; remote mutations stay ordered without waiting behind output polling. */
export function createTerminalRequester(transport:AiTerminalTransport,remote:boolean) {
  const mutations=new Map<string,LocalQueue>();
  const closes=new Map<string,Promise<AiTerminalResponse>>();
  let nextRemoteAt=0, admission:Promise<unknown>=Promise.resolve();
  const writes:PendingRequest[]=[], reads:PendingRequest[]=[];
  let draining=false, writesSinceRead=0, pendingCount=0;
  let activeRemote:PendingRequest|undefined;
  /**
   * The first failed part of a submission fails its group, and every input of that session not yet sent is dropped
   * too: queued behind it (the next draft typed while the failure was still unknown, up to a minute over the relay),
   * it would follow the orphaned prefix — `HEAD:` + `main` all the same (review 2026-10-09).
   */
  const failGroup=(next:PendingRequest,error:unknown):unknown=>{
    if(!next.group||next.group.failed)return error;
    const group=next.group;
    // The held part is the whole submission's last one: the complete command arrives once, nothing was dropped.
    // Its own words (with its code) are the truth; 「다시 보내세요」 would type it twice.
    const laterParts=writes.some(queued=>queued.group===group)||[...mutations.values()].some(queue=>queue.pending.some(queued=>queued.group===group));
    if(isHeldOnPhone(error)&&!laterParts)return error;
    next.group.failed=true;
    const sessionId=next.request.sessionId;
    const drop=(list:PendingRequest[])=>{for(let i=list.length-1;i>=0;i--){const queued=list[i]!;if(queued.request.sessionId===sessionId&&queued.request.operation==='input'){list.splice(i,1);pendingCount--;queued.reject(partAborted());}}};
    drop(writes);const local=sessionId?mutations.get(sessionId):undefined;if(local)drop(local.pending);
    if(isHeldOnPhone(error))return Object.assign(new Error(HELD_PART_NOTICE),{code:REQUEST_UNSENT_CODE,cause:error});
    return withPartialNotice(error);
  };
  const send=async(request:Omit<AiTerminalRequest,'requestId'>)=>transport({...request,requestId:crypto.randomUUID()});
  const cancelled=()=>new Error('터미널 종료 요청으로 대기 중인 입력이 취소되었습니다.');
  // Reserve wire starts independently of response latency, so close can reach
  // the transport while an earlier input response is still pending.
  const remoteSend=async(request:Omit<AiTerminalRequest,'requestId'>,check?:()=>void)=>{
    const slot=admission.catch(()=>{}).then(async()=>{
      const delay=nextRemoteAt-performance.now();
      if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
      nextRemoteAt=performance.now()+REMOTE_REQUEST_INTERVAL_MS;
    });
    admission=slot;await slot;check?.();return send(request);
  };
  const drainLocal=async(key:string,queue:LocalQueue)=>{
    if(queue.draining)return;
    queue.draining=true;
    try {
      while(queue.pending.length){
        const next=queue.pending.shift()!;
        try {if(next.group?.failed)throw partAborted();next.resolve(await send(next.request));}catch(error){next.reject(failGroup(next,error));}finally{pendingCount--;}
      }
    } finally {
      queue.draining=false;if(mutations.get(key)===queue)mutations.delete(key);
    }
  };
  const drain=async()=>{
    if(draining)return;
    draining=true;
    try {
      while(writes.length||reads.length){
        const delay=nextRemoteAt-performance.now();
        if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay));
        if(!writes.length&&!reads.length)break;
        // Select after the throttle wait so newly typed input can overtake queued polls.
        const useRead=reads.length>0&&(!writes.length||writesSinceRead>=MAX_WRITES_BEFORE_READ);
        const next=(useRead?reads:writes).shift()!;
        activeRemote=next;
        writesSinceRead=useRead?0:Math.min(MAX_WRITES_BEFORE_READ,writesSinceRead+1);
        try {if(next.group?.failed)throw partAborted();next.resolve(await remoteSend(next.request,()=>{if(next.cancelled)throw cancelled();}));}catch(error){next.reject(failGroup(next,error));}finally{activeRemote=undefined;pendingCount--;}
      }
    } finally {draining=false;}
  };
  return (request:Omit<AiTerminalRequest,'requestId'>,options:{group?:TerminalSubmissionGroup}={}):Promise<AiTerminalResponse>=>{
    const group=options.group;
    const reading=request.operation==='read'||request.operation==='list';
    const sessionId=request.sessionId;
    if(request.operation==='close'&&sessionId){
      const prior=closes.get(sessionId);if(prior)return prior;
      const queue=mutations.get(sessionId);
      if(queue){for(const next of queue.pending.splice(0)){pendingCount--;next.reject(cancelled());}mutations.delete(sessionId);}
      for(const pending of [writes,reads])for(let i=pending.length-1;i>=0;i--)if(pending[i]!.request.sessionId===sessionId){pendingCount--;pending.splice(i,1)[0]!.reject(cancelled());}
      if(activeRemote?.request.sessionId===sessionId&&['input','resize'].includes(activeRemote.request.operation))activeRemote.cancelled=true;
      const result=remote?remoteSend(request):send(request);closes.set(sessionId,result);
      const settled=()=>{if(closes.get(sessionId)===result)closes.delete(sessionId);};void result.then(settled,settled);
      return result;
    }
    if(!reading&&sessionId&&closes.has(sessionId))return Promise.reject(cancelled());
    if(pendingCount>=TERMINAL_REQUESTER_MAX_PENDING){
      const full=new Error('대기 중인 터미널 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
      // A part refused here fails its group: the parts already queued before it must not go out on their own.
      if(group&&!group.failed){group.failed=true;return Promise.reject(withPartialNotice(full));}
      return Promise.reject(group?partAborted():full);
    }
    pendingCount++;
    if(!remote){
      if(reading)return send(request).finally(()=>{pendingCount--;});
      const key=sessionId??'start';
      const queue=mutations.get(key)??{pending:[],draining:false};mutations.set(key,queue);
      const result=new Promise<AiTerminalResponse>((resolve,reject)=>queue.pending.push({request,resolve,reject,group}));
      void drainLocal(key,queue);
      return result;
    }
    const result=new Promise<AiTerminalResponse>((resolve,reject)=>{
      (reading?reads:writes).push({request,resolve,reject,group});
    });
    void drain();return result;
  };
}
