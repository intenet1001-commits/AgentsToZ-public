import React,{useEffect,useRef,useState} from 'react';

type Comparison={conflict:boolean;memoryId:string;localContent:string;remoteContent:string;localContentHash:string;remoteContentHash:string;remoteRevisionId:string;remoteCreatedAt?:string|null;remoteDeviceName?:string|null};
type Strategy='keep-local'|'use-remote'|'merged';
const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm disabled:opacity-50';
/** Mounted by the local OPS settings only. Reading compares; applying requires a fresh, reviewed pair of versions. */
export function ControlMemoryConflictPanel({profileId,memoryId,request,onResolved}:{profileId:string;memoryId:string;request:(body:Record<string,unknown>)=>Promise<any>;onResolved:()=>void}){
 const [comparison,setComparison]=useState<Comparison|null>(null),[strategy,setStrategy]=useState<Strategy>('merged'),[draft,setDraft]=useState(''),[reviewed,setReviewed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const flight=useRef(false),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const base={expectedProfileId:profileId,expectedMemoryId:memoryId};
 const run=async(operation:()=>Promise<void>)=>{if(flight.current)return;flight.current=true;setBusy(true);try{await operation();}catch(error){if(alive.current)setMessage(error instanceof Error&&/[가-힣]/.test(error.message)?error.message:'결과를 확인하지 못했습니다. 다시 비교해 현재 상태를 확인하세요.');}finally{flight.current=false;if(alive.current)setBusy(false);}};
 const preview=()=>void run(async()=>{
  setMessage('');setComparison(null);setReviewed(false);
  const r=await request({...base,operation:'preview'}),c=r.comparison;
  if(!c||c.memoryId!==memoryId||typeof c.localContent!=='string'||typeof c.remoteContent!=='string'||typeof c.localContentHash!=='string'||typeof c.remoteContentHash!=='string'||typeof c.remoteRevisionId!=='string')throw Error('운영 기억 비교 결과를 확인하지 못했습니다.');
  if(!alive.current)return;setComparison(c);setDraft(c.localContent);setStrategy('merged');
  if(!c.conflict)setMessage('로컬과 원격 운영 기억이 같습니다. 준비·연결을 다시 확인하면 동기화 상태가 갱신됩니다.');
 });
 const apply=()=>{if(!comparison||!comparison.conflict||!reviewed)return;const c=comparison;void run(async()=>{
  // Remove the executable review before awaiting: an uncertain reply cannot leave an Apply button ready for replay.
  setComparison(null);setReviewed(false);setMessage('비교한 버전을 확인하고 적용 중…');
  const r=await request({...base,operation:'resolve',strategy,reviewed:true,expectedLocalHash:c.localContentHash,expectedRemoteRevisionId:c.remoteRevisionId,expectedRemoteContentHash:c.remoteContentHash,...(strategy==='merged'?{mergedContent:draft}:{})});
  if(!alive.current)return;
  if(r.resolution?.success!==true){setMessage('비교 후 기억이 바뀌었습니다. 다시 비교하고 내용을 검토하세요.');return;}
  setMessage('검토한 운영 기억을 적용했습니다. 준비·연결을 다시 확인해 동기화 상태를 갱신하세요.');onResolved();
 });};
 return <section className="mt-3 rounded-lg border border-[var(--line)] p-3 text-sm" data-testid="control-memory-conflict-panel" aria-label="운영 기억 비교">
  <p>이 Mac의 운영 기억과 원격 최신 기록을 비교합니다. 내용을 읽는 동안 어느 쪽도 바꾸지 않습니다.</p>
  <button type="button" className={button+' mt-2'} disabled={busy} onClick={preview}>{busy?'처리 중…':'운영 기억 비교하기'}</button>
  {comparison&&<><div className="mt-3 grid gap-3 md:grid-cols-2">
   <label>이 Mac의 운영 기억<textarea className="mt-1 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm" rows={10} readOnly value={comparison.localContent}/></label>
   <label>원격 운영 기억{comparison.remoteDeviceName?` · ${comparison.remoteDeviceName}`:''}<textarea className="mt-1 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm" rows={10} readOnly value={comparison.remoteContent}/></label>
  </div>{comparison.conflict&&<>
   <fieldset className="mt-3 space-y-2" disabled={busy}><legend>적용할 내용</legend>{([['merged','직접 병합한 내용'],['keep-local','이 Mac의 내용'],['use-remote','원격 내용']] as const).map(([value,label])=><label key={value} className="mr-3 inline-flex min-h-11 items-center gap-2"><input type="radio" name={`ops-conflict-${profileId}`} checked={strategy===value} onChange={()=>{setStrategy(value);setReviewed(false);}}/>{label}</label>)}</fieldset>
   {strategy==='merged'&&<label className="mt-2 block">병합할 운영 기억<textarea className="mt-1 w-full rounded border border-[var(--line)] bg-transparent p-2 text-sm" rows={12} disabled={busy} value={draft} onChange={e=>{setDraft(e.target.value);setReviewed(false);}}/></label>}
   <p className="mt-2">이 Mac의 내용을 선택하면 새 원격 리비전을 만들고 이전 원격 기록을 보존합니다. 원격 또는 병합 내용을 적용할 때 기존 로컬 기록을 먼저 백업합니다.</p>
   <label className="mt-2 flex min-h-11 items-center gap-2"><input type="checkbox" disabled={busy} checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>두 내용을 비교했고 선택한 내용을 적용하겠습니다.</label>
   <button type="button" className={button} disabled={busy||!reviewed||(strategy==='merged'&&!draft.trim())} onClick={apply}>검토한 운영 기억 적용</button>
  </>}</>}
  {message&&<p className="mt-2 whitespace-pre-wrap" role="status">{message}</p>}
 </section>;
}
