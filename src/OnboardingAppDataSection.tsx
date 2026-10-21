export function OnboardingAppDataSection({onOpen,ko=true}:{onOpen?:()=>void;ko?:boolean}){
  return <section aria-label={ko?'앱 데이터 저장·기기 동기화':'AgentsToZ data storage and sync'} data-testid="app-data-connection" className="mt-4 rounded-2xl border border-teal-400/30 bg-teal-500/5 p-5">
    <h3 className="font-semibold">{ko?'아젠투지 앱 데이터 저장·기기 동기화':'AgentsToZ app data storage and sync'}</h3>
    <p className="mt-2 text-sm leading-6">{ko?'프로젝트 목록·설정·장기기억을 다른 기기와 동기화할 저장소입니다. 프로젝트 작업용 CLI 계정과 별도로, 사용할 Supabase 계정과 아젠투지 전용 프로젝트를 선택합니다. 로컬 사용이면 건너뛰어도 됩니다.':'Choose a Supabase account and dedicated project for syncing AgentsToZ data and memory between devices. This is separate from project CLI accounts. You can skip this for local use.'}</p>
    <p className="mt-2 text-xs leading-5">{ko?'이미 다른 PC에서 동기화 중이면 그 PC의 연결 정보를 받아 추가 기기로 연결하세요. iPhone·웹 로그인 허용 이메일은 동기화 설정 안에서 따로 관리합니다.':'If another PC already syncs, use its connection invite. Phone and web sign-in emails are managed separately inside sync settings.'}</p>
    {onOpen?<button type="button" className="mt-3 min-h-11 rounded-xl border border-teal-400/30 px-4 py-2 text-sm" onClick={onOpen}>{ko?'앱 데이터 저장소·기기 동기화 설정':'Open app data storage and sync'}</button>:<p className="mt-3 text-xs">{ko?'설정 창을 닫고 ‘내 기기와 연결 → 첫 기기·동기화 설정’에서 이어가세요.':'Close settings and continue in Device and connections → First device and sync.'}</p>}
  </section>;
}
