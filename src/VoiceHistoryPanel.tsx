import {useEffect,useMemo,useRef,useState} from 'react';
import {localVoiceTransport,type VoiceTransport} from './voiceSessionClient';
import type {VoiceHistoryPage,VoiceHistoryDetail,VoiceHistoryScope,VoiceHistorySession} from './voiceHistoryProtocol';
const button='rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40';
const withoutAgent=(label:string)=>label.replace(/ · (?:codex|claude|hermes|agy)$/i,'');
/** 아젠투지 voice is listed as 아젠투지; a project's voice under its registered name (docs/ui-glossary.md). */
export function voiceHistoryTitle(session:Pick<VoiceHistorySession,'kind'|'label'|'targetId'>,names:ReadonlyMap<string,string>):string{
 return session.kind==='ops'?'아젠투지':(session.targetId&&names.get(session.targetId))||withoutAgent(session.label);
}
const scopeLabel=(scope:VoiceHistoryScope,names:ReadonlyMap<string,string>)=>scope.kind==='ops'?'아젠투지':names.get(scope.key)??scope.label;
/** `initialPage`: a first page already in hand (e.g. a server render); the panel still loads its own on mount. */
export function VoiceHistoryPanel({transport=localVoiceTransport,projects=[],initialPage}:{transport?:VoiceTransport;projects?:readonly {id:string;name:string}[];initialPage?:VoiceHistoryPage}){
 const [page,setPage]=useState<VoiceHistoryPage>(initialPage??{sessions:[],nextBefore:null}),[detail,setDetail]=useState<VoiceHistoryDetail|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[note,setNote]=useState('');
 const [scope,setScope]=useState(''),[scopes,setScopes]=useState<VoiceHistoryScope[]>(initialPage?.scopes??[]);
 const names=useMemo(()=>new Map(projects.map(project=>[project.id,project.name])),[projects]);
 const alive=useRef(true),pending=useRef(false),selected=useRef('');
 const run=async(fn:()=>Promise<void>)=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(alive.current)setError(e instanceof Error?e.message:'음성 기록을 확인하세요.');}finally{pending.current=false;if(alive.current)setBusy(false);}};
 const list=async(before?:string,next=scope)=>{const r=await transport({action:'history.list',requestId:crypto.randomUUID(),...(before?{before}:{}),...(next?{scope:next}:{})});if(alive.current){setPage(r.history!);if(r.history!.scopes)setScopes(r.history!.scopes);setScope(next);setDetail(null);selected.current='';setNotice('');}};
 const read=async(id:string,cursor?:string)=>{const r=await transport({action:'history.read',requestId:crypto.randomUUID(),sessionId:id,...(cursor?{cursor}:{})});if(alive.current){if(selected.current!==id){setNote('');setNotice('');}selected.current=id;setDetail(r.detail!);}};
 useEffect(()=>{alive.current=true;void run(()=>list(undefined,''));return()=>{alive.current=false;};},[transport]);
 const memory=async(status=false)=>{if(!detail)return;const r=await transport({action:status?'history.memory-status':'history.remember',requestId:crypto.randomUUID(),sessionId:detail.session.id});if(alive.current)setNotice(r.reviewMessage??'');};
 const chips=[{key:'',label:'전체'},...scopes.map(item=>({key:item.key,label:scopeLabel(item,names)}))];
 return <div className="min-h-0 flex-1 overflow-auto p-6" data-testid="voice-history-panel">
  <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-bold">음성 세션</h2><p className="mt-1 text-sm text-[var(--ink-3)]">이 Mac에 암호화 저장된 발언과 AI 답변입니다. 원음은 저장하지 않습니다. 아젠투지 호출은 아젠투지에, 프로젝트 워크룸 음성은 그 프로젝트에 남습니다.</p></div><button className={button} disabled={busy} onClick={()=>void run(()=>list())}>새로고침</button></div>
  <p className="mb-4 text-sm">워크룸 대화는 세션 기억하기·기존 자동 기억 설정에 따라 핵심만 정리합니다. 전사 오류와 AI 답변은 실제 작업 완료의 증거가 아닙니다.</p>
  {scopes.length>0&&<div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="음성 세션 범위">{chips.map(item=><button key={item.key||'all'} type="button" data-testid="voice-history-scope" data-scope={item.key||'all'} aria-pressed={scope===item.key} className={`rounded-full border border-[var(--line)] px-3 py-1 text-xs disabled:opacity-40 ${scope===item.key?'bg-[var(--sunken)] font-semibold':''}`} disabled={busy} onClick={()=>void run(()=>list(undefined,item.key))}>{item.label}</button>)}</div>}
  {error&&<p role="alert" className="mb-3 text-[var(--danger)]">{error}</p>}{notice&&<p role="status" className="mb-3">{notice}</p>}
  <div className="grid gap-5 md:grid-cols-[minmax(180px,280px)_1fr]"><div className="flex flex-col gap-2">
   {page.sessions.length===0&&!busy&&<p>{scope?'이 범위에 저장된 음성 세션이 없습니다.':'저장된 음성 세션이 없습니다. 음성을 시작할 때 기록 저장을 켜세요.'}</p>}
   {page.sessions.map(s=>{const title=voiceHistoryTitle(s,names);return <button key={s.id} data-testid="voice-history-session" className={`${button} text-left ${detail?.session.id===s.id?'bg-[var(--sunken)]':''}`} disabled={busy} aria-pressed={detail?.session.id===s.id} onClick={()=>void run(()=>read(s.id))}><strong className="block">{title}</strong>{s.label!==title&&s.label!=='AgentsToZ OPS'&&<span className="block text-xs text-[var(--ink-3)]">{s.label}</span>}<span className="block text-xs">{new Date(s.createdAt).toLocaleString()} · {s.turnCount}개 발언</span><span className="text-xs">{s.endedAt?(s.complete===false?'종료됨 · 일부 기록 확인 필요':'종료됨'):'진행 중 또는 종료 미확인'}</span></button>;})}
   {page.nextBefore&&<button className={button} disabled={busy} onClick={()=>void run(()=>list(page.nextBefore!))}>이전 세션</button>}
  </div><div>{detail?<>
   <h3 className="mb-3 font-semibold">{voiceHistoryTitle(detail.session,names)}</h3>
   {detail.turn?<article className="rounded-xl border border-[var(--line)] p-4"><p className="mb-2 text-xs text-[var(--ink-3)]">{detail.turn.role==='user'?'내가 한 말':'AI 답변'} · {new Date(detail.turn.recordedAt).toLocaleTimeString()}{detail.turn.continued?' · 이어지는 내용':''}</p><p className="whitespace-pre-wrap break-words">{detail.turn.text}</p></article>:<p>저장된 발언이 없습니다.</p>}
   <div className="my-3 flex gap-2"><button className={button} disabled={busy} onClick={()=>void run(()=>read(detail.session.id))}>첫 발언</button>{detail.nextCursor&&<button className={button} disabled={busy} onClick={()=>void run(()=>read(detail.session.id,detail.nextCursor!))}>다음 내용</button>}</div>
   {detail.session.kind==='workroom'?<div className="mt-5 border-t border-[var(--line)] pt-4"><button className={button} disabled={busy||!detail.session.endedAt||detail.session.complete===false} onClick={()=>void run(()=>memory())}>세션 기억하기</button><button className={`${button} ml-2`} disabled={busy} onClick={()=>void run(()=>memory(true))}>저장 상태 확인</button>{detail.session.endedAt&&detail.session.complete===false&&<p className="mt-2 text-xs" data-testid="voice-history-incomplete">일부 발언 저장을 확인하지 못한 세션이라 기억으로 정리하지 않습니다. 발언을 확인한 뒤 필요한 내용은 워크룸에 다시 지시하세요.</p>}<p className="mt-2 text-xs text-[var(--ink-3)]">같은 프로젝트의 채팅과 음성을 함께 정리합니다. 기존 기억용 AI 설정·사용량 한도가 적용됩니다.</p></div>:<div className="mt-5 border-t border-[var(--line)] pt-4"><label className="block">OPS 운영 기억에 남길 핵심<textarea className="my-2 block min-h-28 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] p-3" value={note} onChange={e=>setNote(e.target.value)} disabled={busy||detail.session.reviewed}/></label><button className={button} disabled={busy||!note.trim()||!detail.session.endedAt||detail.session.reviewed} onClick={()=>void run(async()=>{const r=await transport({action:'history.review',requestId:crypto.randomUUID(),sessionId:detail.session.id,text:note});if(alive.current)setNotice(r.reviewMessage??'');})}>운영 기억 후보 저장</button></div>}
  </>:<p className="text-[var(--ink-3)]">세션을 선택해 발언을 확인하세요.</p>}</div></div>
 </div>;
}
