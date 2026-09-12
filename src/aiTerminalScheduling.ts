import type {AiTerminalRequest,AiTerminalResponse} from './aiTerminalProtocol';
import type {AiTerminalTransport} from './aiTerminalClient';

type PendingRequest = {
  request: Omit<AiTerminalRequest,'requestId'>;
  resolve: (response:AiTerminalResponse)=>void;
  reject: (reason:unknown)=>void;
  cancelled?:boolean;
};
type LocalQueue={pending:PendingRequest[];draining:boolean};
export const TERMINAL_REQUESTER_MAX_PENDING = 256;
const REMOTE_REQUEST_INTERVAL_MS=140;
// Four writes per five slots can keep up with the panel's 180 ms input batches.
// The read queue receives every fifth slot under sustained writes (transport time aside).
const MAX_WRITES_BEFORE_READ=4;

/** An input acknowledgement can arrive before the CLI has painted its echo.
 * Keep a short, bounded response window instead of inheriting idle backoff. */
export function createTerminalReadCadence(remote:boolean, now=()=>performance.now()) {
  let idleReads=0, responsiveUntil=0;
  return {
    wake() {idleReads=0;responsiveUntil=now()+1500;},
    next(hasOutput:boolean,hasMore:boolean) {
      idleReads=hasOutput?0:Math.min(5,idleReads+1);
      if(hasMore)return 0;
      if(!remote&&now()<responsiveUntil)return 32;
      return Math.min(remote?5000:2000,(remote?700:120)*2**idleReads);
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
        try {next.resolve(await send(next.request));}catch(error){next.reject(error);}finally{pendingCount--;}
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
        try {next.resolve(await remoteSend(next.request,()=>{if(next.cancelled)throw cancelled();}));}catch(error){next.reject(error);}finally{activeRemote=undefined;pendingCount--;}
      }
    } finally {draining=false;}
  };
  return (request:Omit<AiTerminalRequest,'requestId'>):Promise<AiTerminalResponse>=>{
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
    if(pendingCount>=TERMINAL_REQUESTER_MAX_PENDING)return Promise.reject(new Error('대기 중인 터미널 요청이 너무 많습니다. 잠시 후 다시 시도하세요.'));
    pendingCount++;
    if(!remote){
      if(reading)return send(request).finally(()=>{pendingCount--;});
      const key=sessionId??'start';
      const queue=mutations.get(key)??{pending:[],draining:false};mutations.set(key,queue);
      const result=new Promise<AiTerminalResponse>((resolve,reject)=>queue.pending.push({request,resolve,reject}));
      void drainLocal(key,queue);
      return result;
    }
    const result=new Promise<AiTerminalResponse>((resolve,reject)=>{
      (reading?reads:writes).push({request,resolve,reject});
    });
    void drain();return result;
  };
}
