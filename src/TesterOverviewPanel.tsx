import React,{useEffect,useRef,useState} from 'react';
import type {TesterOverview,TesterOverviewRequest} from './testerOverviewContract';
import {testerStateLabel} from './mobileTesterProtocol';

export function TesterOverviewPanel({transport,onOpenProject}:{transport:(r:TesterOverviewRequest)=>Promise<TesterOverview>;onOpenProject:(id:string)=>void}){
  const [page,setPage]=useState<TesterOverview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),transportRef=useRef(transport);transportRef.current=transport;
  async function refresh(next=false){const mine=++generation.current;setBusy(true);setError('');try{
    const result=await transportRef.current(next&&page?{offset:page.nextOffset??0,revision:page.revision}:{});
    if(mine===generation.current)setPage(result);
  }catch(e){if(mine===generation.current)setError(e instanceof Error?e.message:'테스터 현황을 확인하지 못했습니다.');}finally{if(mine===generation.current)setBusy(false);}}
  useEffect(()=>{void refresh();return()=>{generation.current++;}},[]);
  const button='min-h-11 rounded-lg border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-50';
  return <section data-testid="tester-overview" className="mt-5 border-t border-[var(--line)] pt-4">
    <h3 className="font-bold">프로젝트 테스트 현황 · 이 Mac</h3>
    <p className="mt-1 text-xs">최근 기록을 모아 보여줍니다. 코드 변경 여부는 프로젝트를 열어 확인하세요. 다른 Mac의 결과는 합산하지 않습니다.</p>
    <button className={button} disabled={busy} onClick={()=>void refresh()}>테스트 현황 새로고침</button>
    {busy&&<p role="status">기록 확인 중…</p>}{error&&<p role="alert">{error}</p>}
    {page&&<><p className="my-2 text-xs">{page.hostName} · 조회 {new Date(page.checkedAt).toLocaleString()} · 등록 프로젝트 {page.total}개</p>
      {!page.complete&&<p role="status">일부 프로젝트 등록 정보를 확인하지 못했습니다.</p>}
      {!page.entries.length&&<p>표시할 등록 프로젝트가 없습니다.</p>}
      {page.entries.map(p=><article key={p.projectId} className="my-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--line)] p-3"><div><strong>{p.name}</strong><p className="text-xs">{p.state==='unavailable'?'기록 확인 필요':p.state==='not-configured'?'테스터 설정 필요':p.run?`${testerStateLabel[p.run.state]} · ${p.run.profileId} · ${new Date(p.run.createdAt).toLocaleString()}`:'검사 기록 없음'}</p></div><button className={button} onClick={()=>onOpenProject(p.projectId)}>프로젝트 테스터 열기</button></article>)}
      {page.nextOffset!==null&&<button className={button} disabled={busy} onClick={()=>void refresh(true)}>다음 프로젝트</button>}
    </>}
  </section>;
}
