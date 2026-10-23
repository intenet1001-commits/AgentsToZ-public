import {useEffect,useRef,useState} from 'react';
import type {TesterRequest,TesterResult,TesterTarget} from './testerAgentContract';
import type {TesterImprovementInput,TesterImprovements} from './testerImprovements';
import {commonMemoryUuid} from './commonMemoryCrypto';

const stages={observed:'관측',changed:'개선',rechecked:'재확인'},surfaces={mac:'Mac',iphone13:'iPhone 13',browser:'브라우저'},lanes={installed:'설치 앱','native-fixture':'격리 실기 앱','browser-fixture':'격리 브라우저'},outcomes={clear:'동작이 명확함',confusing:'혼동이 남음',blocked:'확인하지 못함'};
const control={minHeight:44,padding:8,border:'1px solid var(--line)',borderRadius:8,background:'var(--bg-input)',color:'var(--text-primary)',font:'inherit',fontSize:16,maxWidth:'100%'};
/** Bounded observations, separate from deterministic verdicts; no timers, device control or provider calls. */
export function TesterImprovementPanel({target,transport}:{target:TesterTarget;transport:(r:TesterRequest)=>Promise<TesterResult>}){
 const [open,setOpen]=useState(false),[data,setData]=useState<TesterImprovements>(),[selected,setSelected]=useState('');
 const [persona,setPersona]=useState('처음 업무를 시작하는 사용자'),[scenario,setScenario]=useState(''),[expected,setExpected]=useState(''),[note,setNote]=useState(''),[version,setVersion]=useState('');
 const [stage,setStage]=useState<TesterImprovementInput['stage']>('observed'),[outcome,setOutcome]=useState<NonNullable<TesterImprovementInput['outcome']>>('clear'),[surface,setSurface]=useState<TesterImprovementInput['surface']>('mac'),[lane,setLane]=useState<TesterImprovementInput['lane']>('installed');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[limit,setLimit]=useState(12);
 const generation=useRef(0),running=useRef(false),pending=useRef<{key:string;request:TesterRequest}|null>(null);
 const key=target.portId+':'+(target.workspaceTargetId??''),current=useRef(key);current.current=key;
 const item=data?.items.find(row=>row.id===selected);
 useEffect(()=>{generation.current++;setData(undefined);setSelected('');setPersona('처음 업무를 시작하는 사용자');setScenario('');setExpected('');setNote('');setError('');setNotice('');setBusy(false);setLimit(12);running.current=false;pending.current=null;if(open)void act(load);return()=>{generation.current++;};},[key]);
 async function act(fn:()=>Promise<void>){if(running.current)return;const mine=generation.current,scope=key;running.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(mine===generation.current&&scope===current.current)setError(e instanceof Error?e.message:'개선 기록을 확인하지 못했습니다.');}finally{if(mine===generation.current&&scope===current.current){running.current=false;setBusy(false);}}}
 async function load(){const mine=generation.current,scope=key,r=await transport({...target,operation:'improvements'});if(mine!==generation.current||scope!==current.current)return;if(!r.improvements)throw Error('이 호스트는 개선 기록을 지원하지 않습니다. 앱을 업데이트하세요.');setData(r.improvements);}
 function choose(id:string){const row=data?.items.find(v=>v.id===id);setSelected(id);setPersona(row?.persona??'처음 업무를 시작하는 사용자');setScenario(row?.scenario??'');setExpected(row?.expected??'');setNote('');setStage(row?'changed':'observed');pending.current=null;setNotice('');}
 async function save(){
  const mine=generation.current,scope=key,fields={expectedRevision:item?.revision??0,persona,scenario,expected,note,stage,...(stage==='rechecked'?{outcome}:{}),surface,lane,version};
  // A refresh can advance the visible revision after a lost ACK. Keep the original
  // request/revision while the person's draft is unchanged, including after refresh.
  const {expectedRevision:_,...draft}=fields,signature=JSON.stringify([key,draft]);
  if(pending.current?.key!==signature)pending.current={key:signature,request:{...target,operation:'improvement-record',improvement:{requestId:commonMemoryUuid(),...fields}}};
  const request=pending.current.request,r=await transport(request);if(mine!==generation.current||scope!==current.current)return;
  if(!r.improvements)throw Error('저장 결과를 확인하지 못했습니다. 같은 내용으로 다시 확인하세요.');
  setData(r.improvements);setSelected(r.improvements.items.find(row=>row.receipts.some(receipt=>receipt.id===request.improvement!.requestId))?.id??'');setNote('');pending.current=null;setNotice('개선 기록을 저장했습니다. 자동 테스트 판정은 바뀌지 않습니다.');
 }
 const input=(label:string,value:string,change:(v:string)=>void,max:number,readOnly=false)=><label style={{display:'grid',gap:4}}>{label}<input style={{...control,width:'100%',boxSizing:'border-box'}} required maxLength={max} value={value} readOnly={readOnly} onChange={e=>change(e.target.value)}/></label>;
 return <details data-testid="tester-improvement-journal" open={open} onToggle={event=>{const next=event.currentTarget.open;setOpen(next);if(next&&!data)void act(load);}}>
  <summary>개선 시나리오 · 관측과 재확인{data?` · ${data.items.length}개`:''}</summary>
  <div style={{display:'grid',gap:12,paddingTop:10}}>
   <p>어디서 헷갈렸는지, 무엇을 바꿨는지, 다시 확인한 결과를 같은 시나리오에 쌓습니다. 관측은 자동 검사의 통과·실패와 별개입니다.</p>
   {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{busy&&<p role="status">개선 기록 확인 중…</p>}
   {data&&<>
    {!data.items.length&&<p>아직 개선 기록이 없습니다. 실제로 확인한 첫 상황을 남겨 주세요.</p>}
    {data.items.slice(0,limit).map(row=><details key={row.id} data-testid="tester-improvement-item"><summary>{row.scenario} · {stages[row.stage]}{row.outcome?` · ${outcomes[row.outcome]}`:''}</summary>
     <p>{row.persona} · 관측 {row.observations} · 개선 {row.changes} · 재확인 {row.rechecks}</p><p>기대 동작 · {row.expected}</p>
     <ol>{row.events.map(event=><li key={event.requestId}>{stages[event.stage]} · {surfaces[event.surface]} / {lanes[event.lane]} · {event.version} · {event.note}{event.outcome?` · ${outcomes[event.outcome]}`:''}{event.evidence?<small> · 근거 {event.evidence}</small>:null}</li>)}</ol>
     <button type="button" style={control} disabled={busy} onClick={()=>choose(row.id)}>이어서 기록</button>
    </details>)}
    {data.items.length>limit&&<button type="button" style={control} onClick={()=>setLimit(n=>n+12)}>시나리오 더 보기</button>}
    <form onSubmit={event=>{event.preventDefault();void act(save);}} style={{display:'grid',gap:10}}>
     <strong>{selected?'선택한 시나리오에 기록':'새 개선 시나리오'}</strong>{selected&&<button type="button" style={control} disabled={busy} onClick={()=>choose('')}>새 시나리오 작성</button>}
     <fieldset disabled={busy} style={{display:'grid',gap:10,minWidth:0,border:0,padding:0}}>
      {input('사용자 관점',persona,setPersona,120,!!selected)}{input('확인한 상황',scenario,setScenario,180,!!selected)}{input('기대했던 동작',expected,setExpected,400)}
      <label>기록 단계<select aria-label="기록 단계" style={control} value={stage} onChange={e=>setStage(e.target.value as typeof stage)}>{Object.entries(stages).map(([value,label])=><option key={value} value={value} disabled={!selected&&value!=='observed'}>{label}</option>)}</select></label>
      <label>기기<select aria-label="기기" style={control} value={surface} onChange={e=>setSurface(e.target.value as typeof surface)}>{Object.entries(surfaces).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label>검증 환경<select aria-label="검증 환경" style={control} value={lane} onChange={e=>setLane(e.target.value as typeof lane)}>{Object.entries(lanes).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {input('확인한 버전',version,setVersion,80)}
      {stage==='rechecked'&&<label>재확인 관측<select aria-label="재확인 관측" style={control} value={outcome} onChange={e=>setOutcome(e.target.value as typeof outcome)}>{Object.entries(outcomes).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>}
      <label style={{display:'grid',gap:4}}>핵심 내용<textarea aria-label="핵심 내용" style={{...control,width:'100%',boxSizing:'border-box'}} required rows={3} maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label>
      <button type="submit" style={control}>관측 기록 저장</button>
     </fieldset>
    </form>
    <button type="button" style={control} disabled={busy} onClick={()=>void act(load)}>기록 새로 고침</button>
    <small>같은 상황은 누적으로 묶고 최근 6개 기록을 표시합니다. 첫 관측 시점과 누적 횟수는 보존됩니다. 장문 로그·개인정보·인증 정보는 남기지 마세요.</small>
   </>}
  </div>
 </details>;
}
