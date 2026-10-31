import {AiTerminalServerResponseError,terminalLocalRequest} from './aiTerminalClient';
import {CONTEXT_SESSION_COMMAND_PATH,runContextSessionCommand,type ContextCommand,type ContextCommandBinding} from './contextSessionCommand';
const KEY='agentstoz:context-command:pending:v1';
/** `surface:'orca'` is an Orca Claude terminal: its receipt is read and acknowledged by providerSessionId (sessionId is the same).
 *  `startedAt` (when the request was made) lets a receipt confirmed later still be followed to its outcome
 *  (src/contextCommandOutcome.ts); older entries have none. */
export interface ContextCommandAttempt {requestId:string;sessionId:string;providerSessionId:string;command:ContextCommand;surface?:'orca';startedAt?:number}
export function contextCommandAttempts():ContextCommandAttempt[]{
  try{const v=JSON.parse(localStorage.getItem(KEY)??'[]');return Array.isArray(v)?v.filter(r=>r&&['compact','clear'].includes(r.command)&&(r.surface===undefined||r.surface==='orca')&&['requestId','sessionId','providerSessionId'].every(k=>typeof r[k]==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(r[k]))).slice(-64):[];}catch{return [];}
}
const store=(items:ContextCommandAttempt[])=>localStorage.setItem(KEY,JSON.stringify(items.slice(-64)));
export const contextCommandBindings=async():Promise<ContextCommandBinding[]>=>{
  const r=await terminalLocalRequest(CONTEXT_SESSION_COMMAND_PATH,{operation:'context.status'});
  return Array.isArray(r.bindings)?r.bindings:[];
};
const release=(requestId:string)=>store(contextCommandAttempts().filter(a=>a.requestId!==requestId));
export async function checkContextCommand(attempt:ContextCommandAttempt){
  const r=await terminalLocalRequest(CONTEXT_SESSION_COMMAND_PATH,attempt.surface==='orca'
    ?{operation:'context.orca.receipt',providerSessionId:attempt.providerSessionId,requestId:attempt.requestId}
    :{operation:'context.receipt',sessionId:attempt.sessionId,requestId:attempt.requestId});
  // Even not-found does not release the fence: an earlier request may still be arriving.
  if(r.state==='written'||r.state==='rejected'||attempt.surface==='orca'&&r.acknowledged===true)release(attempt.requestId);
  return r.state as string;
}
/** A person's 「미확정 해제」 for one Orca receipt: it releases only that request, and only after the host answered for it —
 *  a settled receipt, or an acknowledgement the host recorded. A request it never recorded is acknowledged as a
 *  tombstone that refuses any late arrival of it (src/contextOrcaCommand.ts), so `not-found` releases too. */
export async function acknowledgeContextCommand(attempt:ContextCommandAttempt){
  if(attempt.surface!=='orca'){
    // A Workroom keeps no fence of its own, and a closed Workroom session takes no more input: a late arrival of this
    // request is refused (src/aiTerminalService.ts), and a reopened conversation is another session. Only then, and only
    // from a person, is the unknown outcome released. An older host that does not say `sessionOpen` keeps it.
    const r=await terminalLocalRequest(CONTEXT_SESSION_COMMAND_PATH,{operation:'context.receipt',sessionId:attempt.sessionId,requestId:attempt.requestId});
    if(r.state==='written'||r.state==='rejected'){release(attempt.requestId);return r.state as string;}
    if(r.sessionOpen!==false)throw Error('워크룸 세션이 아직 열려 있어 해제하지 않았습니다. 워크룸 화면에서 결과를 확인하세요.');
    release(attempt.requestId);
    return 'closed';
  }
  const r=await terminalLocalRequest(CONTEXT_SESSION_COMMAND_PATH,{operation:'context.orca.acknowledge',providerSessionId:attempt.providerSessionId,requestId:attempt.requestId});
  if(r.state!=='written'&&r.state!=='rejected'&&r.acknowledged!==true)throw Error('미확정 해제를 기록하지 못했습니다.');
  release(attempt.requestId);
  return r.state as string;
}
/** Orca Claude: the row is already saved (the button requires it); confirm the sync, then the host re-verifies everything. */
export async function syncAndRunOrcaContextCommand(providerSessionId:string,command:ContextCommand,sync:()=>Promise<{ok?:boolean;conflict?:boolean}>,progress:(message:string)=>void){
  if(contextCommandAttempts().some(a=>a.providerSessionId===providerSessionId))throw Error('이전 컨텍스트 명령의 결과를 먼저 확인하세요. 자동으로 다시 보내지 않습니다.');
  progress('로컬·Supabase 동기화 확인 중…');
  const synced=await sync();
  if(synced.ok!==true||synced.conflict)throw Error('동기화 완료를 확인하지 못했습니다. 컨텍스트 명령은 보내지 않았습니다.');
  progress(`Orca 입력칸 확인 후 /${command} 전송 중…`);
  const attempt:ContextCommandAttempt={requestId:crypto.randomUUID(),sessionId:providerSessionId,providerSessionId,command,surface:'orca',startedAt:Date.now()};
  store([...contextCommandAttempts(),attempt]); // Persist before a potentially lost reply.
  let r:{state?:string;error?:string};
  try{r=await terminalLocalRequest(CONTEXT_SESSION_COMMAND_PATH,{operation:'context.orca.execute',command,providerSessionId,requestId:attempt.requestId});}
  catch(error){
    // The host answered: it refuses before any write (src/contextOrcaCommand.ts records every post-write outcome).
    if(error instanceof AiTerminalServerResponseError){release(attempt.requestId);throw error;}
    // A lost reply may already have a durable receipt. Read it once; never resend.
    const state=await checkContextCommand(attempt).catch(()=>null);
    if(state==='rejected')throw error;
    if(state!=='written')throw Error('Orca 전송 결과가 미확정입니다. 같은 명령을 다시 보내지 말고 Orca 화면을 확인하세요.');
    r={state};
  }
  if(r.state==='written'||r.state==='rejected')release(attempt.requestId);
  if(r.state==='rejected')throw Error(r.error||'명령을 보내기 전에 중단됐습니다.');
  if(r.state!=='written')throw Error(r.error||'Orca 전송 결과가 미확정입니다. 같은 명령을 다시 보내지 말고 Orca 화면을 확인하세요.');
  // Sent is not processed: the dock follows the outcome on this row (src/contextCommandOutcome.ts).
  return `기억 저장·동기화를 확인한 뒤 Orca의 Claude에 /${command}를 전송했습니다.`;
}
export async function syncAndRunContextCommand(binding:ContextCommandBinding,command:ContextCommand,sync:()=>Promise<{ok?:boolean;conflict?:boolean}>,progress:(message:string)=>void){
  if(contextCommandAttempts().some(a=>a.providerSessionId===binding.providerSessionId))throw Error('이전 컨텍스트 명령의 결과를 먼저 확인하세요. 자동으로 다시 보내지 않습니다.');
  const latest=(await contextCommandBindings()).find(b=>b.providerSessionId===binding.providerSessionId&&b.sessionId===binding.sessionId&&b.targetId===binding.targetId);
  if(!latest)throw Error('현재 대화와 워크룸의 연결을 확인하지 못했습니다. 명령을 보내지 않았습니다.');
  binding=latest; // A prior command or keystroke may be newer than the five-second UI poll.
  const requestId=crypto.randomUUID(),saveRequestId=crypto.randomUUID();
  const read=async(action:'workroom.save'|'workroom.status')=>{
    const r=await terminalLocalRequest(CONTEXT_SESSION_COMMAND_PATH,{operation:action==='workroom.save'?'context.save':'context.save-status',command,requestId,saveRequestId,providerSessionId:binding.providerSessionId,sessionId:binding.sessionId,inputRevision:binding.inputRevision});
    const save=r.workroom?.save;
    if(r.workroom?.sessionId!==binding.sessionId||save?.requestId!==saveRequestId)throw Error('현재 세션의 저장 영수증을 확인하지 못했습니다. 명령을 보내지 않았습니다.');
    return save;
  };
  return runContextSessionCommand({binding,command,requestId},{save:()=>read('workroom.save'),status:()=>read('workroom.status'),sync,progress,execute:async()=>{
    const attempt:ContextCommandAttempt={requestId,sessionId:binding.sessionId,providerSessionId:binding.providerSessionId,command,startedAt:Date.now()};
    store([...contextCommandAttempts(),attempt]); // Persist before a potentially lost reply.
    try{
      const r=await terminalLocalRequest(CONTEXT_SESSION_COMMAND_PATH,{operation:'context.execute',command,providerSessionId:binding.providerSessionId,sessionId:binding.sessionId,requestId,saveRequestId,inputRevision:binding.inputRevision});
      if(r.state==='written'||r.state==='rejected')store(contextCommandAttempts().filter(a=>a.requestId!==requestId));
      return r;
    }catch(error){
      // A lost reply may already have a durable receipt. Read it once; never resend.
      const state=await checkContextCommand(attempt).catch(()=>null);
      if(state==='written'||state==='rejected')return {state,...(state==='rejected'?{error:error instanceof Error?error.message:String(error)}:{})};
      throw error;
    }
  }});
}
