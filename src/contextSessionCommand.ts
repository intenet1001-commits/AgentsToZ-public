/** Local Workroom control only. Never a raw terminal handle or arbitrary command. */
export interface ContextCommandBinding {providerSessionId:string;sessionId:string;targetId:string;inputRevision:number}
export const CONTEXT_SESSION_COMMAND_PATH='/api/agent-runtime/context-sessions';
export type ContextCommand='compact'|'clear';
/** A manual session switch also retires the launch ID; a recent old snapshot cannot target the new chat. */
export function claudeInputChangesConversation(data:string,frame?:{rows:readonly string[];cursorRow:number}|null):boolean {
  const command=/^\s*\/(?:clear|reset|new|resume|fork)(?:\s|$)/;
  if(!data.endsWith('\r'))return false;
  if(command.test(data))return true;
  if(!frame)return false;
  for(let row=frame.cursorRow;row>=Math.max(0,frame.cursorRow-8);row--){
    const line=frame.rows[row]??'';
    if(/^\s*[─━]{5,}\s*$/.test(line))break;
    const prompt=/^\s*[>›»❯]\s*(.*)$/.exec(line);
    if(prompt)return command.test(prompt[1]!);
  }
  return false;
}
/** An Orca Claude terminal has no Workroom session: the server finds it again from the row's captured Orca identity.
 *  Its request ID doubles as Orca's `--retry-request` identity, so it must be a UUID. */
export type ContextOrcaCommandRequest={operation:'context.orca.execute';command:ContextCommand;providerSessionId:string;requestId:string}|{operation:'context.orca.receipt'|'context.orca.acknowledge';providerSessionId:string;requestId:string};
export type ContextCommandRequest={operation:'context.status'}|{operation:'context.receipt';sessionId:string;requestId:string}|{operation:'context.execute'|'context.save'|'context.save-status';command:ContextCommand;providerSessionId:string;sessionId:string;requestId:string;saveRequestId:string;inputRevision:number}|ContextOrcaCommandRequest;
export const isContextOrcaRequest=(request:ContextCommandRequest):request is ContextOrcaCommandRequest=>request.operation.startsWith('context.orca.');
const ORCA_REQUEST_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeContextCommandRequest(value:unknown):ContextCommandRequest {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('컨텍스트 요청 형식이 올바르지 않습니다.');
  const r=value as Record<string,unknown>;
  if(r.operation==='context.status'&&Object.keys(r).length===1)return {operation:'context.status'};
  if(typeof r.operation==='string'&&r.operation.startsWith('context.orca.')){
    const keys=r.operation==='context.orca.execute'?['operation','command','providerSessionId','requestId']:['operation','providerSessionId','requestId'];
    if(!['context.orca.execute','context.orca.receipt','context.orca.acknowledge'].includes(r.operation)||Object.keys(r).length!==keys.length||Object.keys(r).some(k=>!keys.includes(k))
      ||r.operation==='context.orca.execute'&&!['compact','clear'].includes(r.command as string)
      ||typeof r.providerSessionId!=='string'||!/^[A-Za-z0-9_-]{8,160}$/.test(r.providerSessionId)||typeof r.requestId!=='string'||!ORCA_REQUEST_ID.test(r.requestId))throw Error('확인된 Orca 세션과 고정된 /compact·/clear 명령만 요청할 수 있습니다.');
    return r as ContextOrcaCommandRequest;
  }
  if(r.operation==='context.receipt'&&Object.keys(r).length===3&&['sessionId','requestId'].every(k=>typeof r[k]==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(r[k] as string)))return r as ContextCommandRequest;
  const keys=['operation','command','providerSessionId','sessionId','requestId','saveRequestId','inputRevision'];
  if(!['context.execute','context.save','context.save-status'].includes(r.operation as string)||Object.keys(r).length!==keys.length||Object.keys(r).some(k=>!keys.includes(k))
    ||!['compact','clear'].includes(r.command as string)||!['providerSessionId','sessionId','requestId','saveRequestId'].every(k=>typeof r[k]==='string'&&/^[A-Za-z0-9_-]{8,160}$/.test(r[k] as string))
    ||!Number.isSafeInteger(r.inputRevision)||(r.inputRevision as number)<0)throw Error('확인된 세션과 고정된 /compact·/clear 명령만 요청할 수 있습니다.');
  return r as ContextCommandRequest;
}

/** Save receipt → sync → fixed native command. Unknown outcomes are never replayed. */
export async function runContextSessionCommand(input:{binding:ContextCommandBinding;command:ContextCommand;requestId:string},host:{
  save:()=>Promise<{state:string;localSaved:boolean}>;
  status:()=>Promise<{state:string;localSaved:boolean}>;
  sync:()=>Promise<{ok?:boolean;conflict?:boolean}>;
  execute:()=>Promise<{state:string;error?:string}>;
  progress:(message:string)=>void;
  sleep?:(ms:number)=>Promise<void>;
}){
  host.progress('대화·작업을 기억에 저장 중…');
  let saved=await host.save();
  const deadline=Date.now()+8*60_000;
  while(saved.state==='saving'&&Date.now()<deadline){await (host.sleep??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(2000);saved=await host.status();}
  if(!saved.localSaved||saved.state!=='saved')throw Error('현재 세션의 저장 완료를 확인하지 못했습니다. 컨텍스트 명령은 보내지 않았습니다.');
  host.progress('로컬·Supabase 동기화 중…');
  const sync=await host.sync();
  if(sync.ok!==true||sync.conflict)throw Error('동기화 완료를 확인하지 못했습니다. 컨텍스트 명령은 보내지 않았습니다.');
  host.progress(`/${input.command} 전송 중…`);
  const result=await host.execute();
  if(result.state==='rejected')throw Error(result.error||'명령을 보내기 전에 중단됐습니다. 현재 세션과 입력을 확인한 뒤 다시 실행하세요.');
  if(result.state!=='written')throw Error('명령 전송 결과가 미확정입니다. 같은 명령을 다시 보내지 말고 워크룸을 확인하세요.');
  // Sent is not processed: the dock follows the outcome on this row (src/contextCommandOutcome.ts).
  return `기억 저장·동기화 후 /${input.command} 명령을 전송했습니다.`;
}
