import {useRef,useState} from 'react';
import {terminalLocalRequest} from './aiTerminalClient';
import {isTauri} from './lib/env';
import {MemorySaveRecoveryAttempt,MEMORY_RECOVERY_UNCONFIRMED} from './memorySaveNoticeRecovery';
import {MEMORY_SAVE_NOTICE_RECOVERY_PATH} from './memorySaveNoticeRecoveryRoute';
import {phoneDateTime} from './phoneTime';
import {openWorkroomPopout} from './workroomPopoutClient';
import {normalizeAiTerminalResponse,type AiTerminalAgent,type AiTerminalSummary} from './aiTerminalProtocol';
import type {SaveItem} from './unsavedSessionMemory';

export function MemorySaveRecoveryAction({item}:{item:SaveItem}){
  const [expanded,setExpanded]=useState(false),[agent,setAgent]=useState<AiTerminalAgent>(item.agent),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [rooms,setRooms]=useState<readonly AiTerminalSummary[]|null>(null);
  const problem=item.problem??(item.status==='unknown'?'unknown':'state');
  const attempt=useRef<MemorySaveRecoveryAttempt|null>(null);
  if(!attempt.current)attempt.current=new MemorySaveRecoveryAttempt({...item,problem},{
    resolve:async folder=>{
      const response=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/project-memory/resolve-project`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({project:folder}),signal:AbortSignal.timeout(10_000)});
      const value=await response.json();if(!response.ok||value.ok!==true||typeof value.id!=='string')throw Error();return {id:value.id};
    },
    start:async request=>{
      try{return normalizeAiTerminalResponse(await terminalLocalRequest(MEMORY_SAVE_NOTICE_RECOVERY_PATH,{operation:'start',requestId:request.requestId,targetId:request.targetId,agent:request.agent,problem}));}
      catch{throw Error(MEMORY_RECOVERY_UNCONFIRMED);}
    },
    list:async(targetId,agent)=>normalizeAiTerminalResponse(await terminalLocalRequest(MEMORY_SAVE_NOTICE_RECOVERY_PATH,{operation:'list',requestId:crypto.randomUUID(),targetId,agent})).sessions??[],
    open:openWorkroomPopout,newId:()=>crypto.randomUUID(),
  });
  const controller=attempt.current;
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setMessage('');try{await action();}catch(error){setMessage(error instanceof Error?error.message:'워크룸 결과를 확인하지 못했습니다.');}finally{setBusy(false);}};
  const label=problem==='backup'?'백업 확인':problem==='unknown'?'결과 확인':'확인·해결';
  return <div className="az-memory-recovery" data-testid="memory-save-recovery">
    <button type="button" className="az-memory-recovery__toggle" aria-expanded={expanded} aria-label={`${item.name} ${label}`} onClick={()=>setExpanded(!expanded)}>{label}</button>
    {expanded&&<section aria-label={`${item.name} 기억 저장 해결`} className="az-memory-recovery__panel">
      <p>기존 기억과 저장 결과를 확인할 워크룸을 엽니다.</p>
      <label>진단할 AI <select aria-label={`${item.name} 진단할 AI`} value={agent} disabled={busy||controller.phase!=='idle'} onChange={event=>setAgent(event.target.value as AiTerminalAgent)}>
        <option value="codex">Codex</option><option value="claude">Claude</option>
      </select></label>
      {controller.phase!=='unconfirmed'&&<button type="button" className="az-notice__primary" disabled={busy} data-testid="memory-save-recovery-start"
        onClick={()=>void run(async()=>{await controller.launch(agent);setMessage('워크룸을 열었습니다. 진단 결과와 복구안을 확인하세요.');})}>{busy?'워크룸 준비 중…':controller.session?'같은 워크룸 다시 열기':'워크룸 열고 진단'}</button>}
      {controller.phase==='unconfirmed'&&<button type="button" className="az-notice__primary" disabled={busy} onClick={()=>void run(async()=>{setRooms(await controller.rooms());})}>프로젝트 워크룸 목록 확인</button>}
      {rooms&&<div className="az-memory-recovery__rooms">{rooms.length===0?<p>현재 확인되는 워크룸이 없습니다. 시작 결과가 미확정이므로 자동 재실행하지 않습니다.</p>:rooms.map(room=><button type="button" disabled={busy} key={room.id} onClick={()=>void run(()=>controller.openListed(room.id))}>
        {room.agent==='codex'?'Codex':'Claude'} · {room.state==='running'?'실행 중':'종료됨'} · {phoneDateTime(room.createdAt)} 열기
      </button>)}</div>}
      {message&&<p role="status">{message}</p>}
    </section>}
  </div>;
}
