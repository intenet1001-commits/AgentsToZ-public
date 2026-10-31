import {useState} from 'react';
import {writeOnboardingClipboard} from './onboardingClipboard';
import {GOOGLE_WORKSPACE_COMPUTER_USE_HANDOFF} from './googleWorkspaceOnboardingGuide';
import {GoogleWorkspaceSetupWizard} from './GoogleWorkspaceSetupWizard';
import {openHelpdeskAssist} from './helpdeskAssistClient';
import {ASSIST_BUTTON} from './helpdeskAssistProtocol';

/** `assist` is off where this sits inside the help's own step (the help is already open). */
export function GoogleWorkspaceSetupHelp({ko,projectId,assist=true}:{ko:boolean;projectId?:string;assist?:boolean}){
  const [shown,setShown]=useState(false),[copied,setCopied]=useState<boolean|null>(null);
  const [guide,setGuide]=useState(false);
  return <div className="space-y-2 rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] p-3" role="group" aria-label={ko?'Google 설정부터 도움받기':'Get help with Google setup'}>
    <strong className="text-sm">{ko?projectId?'기존 Google 프로젝트의 설정을 이어가세요':'JSON 파일이 아직 없나요?':projectId?'Continue setup in the existing Google project':'No client JSON yet?'}</strong>
    <button type="button" className="helpdesk-button min-h-[44px]" onClick={()=>setGuide(true)}>{ko?'Google 콘솔 · 클릭하며 따라하기':'Open the step-by-step Google guide'}</button>
    {assist&&<button type="button" className="helpdesk-button helpdesk-primary min-h-[44px]" onClick={()=>openHelpdeskAssist({service:'google-workspace',goal:'connect',stage:'gws',scope:{kind:'account-add'},origin:'google-setup-help'})}>{ko?`${ASSIST_BUTTON} · 에고라이트 또는 아젠투지브라우저로 함께 진행`:'Helpdesk assist · continue together in Ego Lite or the AgentsToZ browser'}</button>}
    {guide&&<GoogleWorkspaceSetupWizard projectId={projectId} onClose={()=>setGuide(false)}/>}
    <p className="text-xs leading-5">{ko?'① Console 화면 이동과 이름·이메일 입력은 함께 진행 → ② 클라이언트 만들기·JSON 다운로드와 앱 첨부는 직접 → ③ Google 로그인·실제 연결 확인. 대안으로 아래 안내를 복사해 컴퓨터 사용이 가능한 Codex 대화에 붙여넣을 수도 있습니다.':'1. Move through the Console together. 2. Create the client, download the JSON and attach it yourself. 3. Sign in and verify. Alternatively, copy the guide into a Codex conversation with computer use.'}</p>
    <button type="button" className="min-h-[44px] rounded-lg border border-[var(--accent-line)] px-3 py-2 text-xs" onClick={()=>{setShown(true);void writeOnboardingClipboard(GOOGLE_WORKSPACE_COMPUTER_USE_HANDOFF).then(setCopied);}}>{ko?'대안 · Codex 컴퓨터 사용 안내 복사':'Alternative · copy Codex computer use guide'}</button>
    {shown&&<><p className="text-xs" role="status">{copied===null?(ko?'안내를 준비하고 있습니다.':'Preparing the guide.'):copied?(ko?'안내를 복사했습니다. Codex에 붙여넣으면 이어서 도움받을 수 있습니다.':'Copied. Paste it into Codex to continue.'):(ko?'자동 복사를 못 했습니다. 아래 안내를 선택해 복사하세요.':'Copy failed. Select and copy the guide below.')}</p><textarea readOnly aria-label={ko?'Google 설정 컴퓨터 사용 인계문':'Google setup computer use handoff'} value={GOOGLE_WORKSPACE_COMPUTER_USE_HANDOFF} onFocus={e=>e.currentTarget.select()} className="min-h-40 w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2 text-xs"/></>}
    <p className="text-xs leading-5">{ko?'컴퓨터 사용도 화면 내용을 AI가 처리할 수 있습니다. JSON 내용·비밀번호는 AI에게 보내지 않고 생성·다운로드·앱 첨부는 직접 마무리하세요. 안내 복사만으로 설정이나 AI 실행이 시작되지는 않습니다.':'Computer use can expose visible content to the AI. Keep JSON contents and passwords out of the conversation; finish creation, download and app attachment yourself. Copying does not start setup or run an AI.'}</p>
  </div>;
}
