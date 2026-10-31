import React,{useState} from 'react';
import {HELPDESK_SCREEN_GUIDES,type HelpdeskScreenGuide} from './helpdeskScreenGuides';

/** Pre-auth help only: does not start registration, authentication or an AI call. */
export function HelpdeskScreenSetup({onBack}:{onBack:()=>void}){
  const [selected,setSelected]=useState<HelpdeskScreenGuide>('nearby'),[step,setStep]=useState(0);
  const guide=HELPDESK_SCREEN_GUIDES[selected],last=step===guide.steps.length-1;
  return <section className="helpdesk-task" aria-label="Mac 화면 연결 안내">
    <div className="helpdesk-bubble"><h3>Mac 화면 연결을 도와드릴게요</h3><p>지금 필요한 안내를 고르세요. 본인 인증과 실제 화면 확인은 각 기기에서 진행합니다.</p>
      <div className="helpdesk-intents" aria-label="Mac 화면 연결 상황">{(Object.keys(HELPDESK_SCREEN_GUIDES) as HelpdeskScreenGuide[]).map(id=><button key={id} type="button" aria-pressed={selected===id} onClick={()=>{setSelected(id);setStep(0);}}>{HELPDESK_SCREEN_GUIDES[id].label}</button>)}</div>
    </div>
    <article className="helpdesk-bubble" aria-live="polite" aria-atomic="true"><h4>{guide.title}</h4><p className="text-sm">단계 {step+1} / {guide.steps.length}</p><p>{guide.steps[step]}</p></article>
    <div className="helpdesk-actions"><button type="button" className="helpdesk-button" disabled={step===0} onClick={()=>setStep(n=>n-1)}>이전 단계</button>{!last&&<button type="button" className="helpdesk-button helpdesk-primary" onClick={()=>setStep(n=>n+1)}>다음 단계</button>}<button type="button" className="helpdesk-button" onClick={onBack}>{last?'질문으로 돌아가기':'질문하기'}</button></div>
  </section>;
}
