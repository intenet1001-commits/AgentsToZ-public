import React,{useState} from 'react';
import type {PreparationState} from './onboardingProgress';
import type {OnboardingPlatform} from './onboardingInfrastructure';
import {ONBOARDING_TOOLS} from './onboardingInfrastructure';
import {writeOnboardingClipboard} from './onboardingClipboard';
import {codexLoginCommand} from './onboardingCodexDiagnosis';
export default function OnboardingCodexPreparation({state,platform,onOpenFirstTask,preferAutomaticInstall=false,preferAutomaticLogin=false}:{state:PreparationState;platform:OnboardingPlatform;onOpenFirstTask?:()=>void;preferAutomaticInstall?:boolean;preferAutomaticLogin?:boolean}){
 const [notice,setNotice]=useState('');
 const configured=state==='configured'||state==='ready';
 const install=ONBOARDING_TOOLS.find(t=>t.id==='codex')?.install[platform];
 const button='min-h-11 rounded-xl border border-[var(--line)] px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]';
 async function copy(value:string){setNotice(await writeOnboardingClipboard(value)?'복사했습니다. 이 기기의 터미널에 붙여 넣으세요. 실행 뒤 위의 상태 확인 버튼을 눌러 주세요.':'복사하지 못했습니다. 공식 안내에서 명령을 확인하세요.');}
 return <section aria-label="Codex 첫 작업 준비" className="mt-4 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] p-4">
  <h4 className="font-semibold">Codex로 첫 작업 준비</h4>
  <p className="mt-2 text-sm leading-relaxed">{configured?'저장된 로그인 정보를 찾았습니다. 이제 프로젝트에서 첫 요청을 실행해 실제 연결과 결과를 확인하세요.':'설치 → 로그인 → 실제 상태 확인 순서로 진행합니다. 명령을 복사하거나 로그인 창을 여는 것만으로 완료 처리하지 않습니다.'}</p>
  {!configured&&!preferAutomaticLogin&&<p className="mt-2 text-sm leading-relaxed">Mac은 터미널, Windows는 PowerShell에서 실행하세요. 로그인은 AI 워크룸이 아닌 별도 터미널과 공식 로그인 화면에서 진행합니다. 기존 로그인 정보를 지우거나 API 키를 이 앱에 붙여 넣을 필요는 없습니다.</p>}
  <div className="mt-3 flex flex-wrap gap-2">
   {state==='missing'&&install&&!preferAutomaticInstall&&<button type="button" className={button} onClick={()=>void copy(install)}>공식 설치 명령 복사</button>}
   {!preferAutomaticLogin&&(state==='installed'||state==='needs-login')&&<button type="button" className={button} onClick={()=>void copy(codexLoginCommand(platform))}>로그인 명령 복사</button>}
   <a className={button} href="https://learn.chatgpt.com/docs/codex/cli" target="_blank" rel="noopener noreferrer">공식 설치·로그인 안내</a>
   {configured&&onOpenFirstTask&&<button type="button" className={`${button} bg-[var(--accent)] text-[var(--on-accent)]`} onClick={onOpenFirstTask}>첫 AI 작업 열기</button>}
   {configured&&!onOpenFirstTask&&<a className={button} href="/">앱 작업 공간으로 돌아가기</a>}
  </div>
  {notice&&<p role="status" className="mt-3 text-sm">{notice}</p>}
 </section>;
}
