import {isTauri} from '@tauri-apps/api/core';
import {useAppLanguage} from './useAppLanguage';
import {useViewerHelper,type ViewerHelperStatus} from './useViewerHelper';
import './CommunityDeviceRegistration.css';

export type CommunityRegistrationEntryState='browser'|'checking'|'unsupported'|'unknown'|'other-instance'|'update-waiting'|'missing'|'available';

/** Display/admission hints only. The existing native open command repeats its own fresh checks. */
export function communityRegistrationEntryState(native:boolean,status:ViewerHelperStatus|null,statusFailed=false):CommunityRegistrationEntryState{
  if(!native)return 'browser';
  if(statusFailed||status?.instanceStatusUnknown)return 'unknown';
  if(!status)return 'checking';
  if(status.supported===false)return 'unsupported';
  if(['supported','installed','bundled','running','updatePending','otherInstanceRunning','instanceStatusUnknown'].some(key=>typeof status[key as keyof ViewerHelperStatus]!=='boolean'))return 'unknown';
  if(status.otherInstanceRunning)return 'other-instance';
  if(status.updatePending&&status.running)return 'update-waiting';
  if(!status.installed&&!status.bundled)return 'missing';
  return 'available';
}

const messages={
  ko:{title:'기기 등록·기능 승인',description:'화면 보기·조작과 사용할 기능을 한곳에서 등록하고 승인받습니다. 대화 참여와 기능 등록 상태는 각각 확인해 주세요.',
    button:'등록·승인 안내 열기',opening:'창 여는 중…',next:'열린 AgentsToZ Viewer에서 「커뮤니티 기기 등록·승인…」을 누르세요. 사용할 기능을 선택하고 등록 요청·승인을 진행합니다. Mac의 기기 신뢰 항목은 별도로 선택해 승인합니다.',
    checking:'Mac 등록 창의 실행 상태를 확인하고 있습니다…',unsupported:'이 기기에서는 Mac 등록 창을 지원하지 않습니다. Mac용 AgentsToZ 앱에서 진행해 주세요.',
    unknown:'등록 창의 상태를 확인하지 못했습니다. 확인될 때까지 열지 않으며 잠시 후 자동으로 다시 확인합니다.',
    'other-instance':'다른 위치의 AgentsToZ Viewer가 실행 중입니다. 현재 연결을 마친 뒤 그 앱을 완전히 종료해 주세요.',
    'update-waiting':'AgentsToZ Viewer 업데이트가 기다리고 있습니다. 현재 연결을 마친 뒤 그 앱을 완전히 종료하고 여기서 다시 여세요.',
    missing:'이 Mac 앱에서 등록 창을 찾지 못했습니다. AgentsToZ를 업데이트한 뒤 다시 확인해 주세요.',available:'등록 안내 창을 열 수 있습니다. 등록·승인 상태는 열린 창에서 확인해 주세요.',
    pending:'창을 열 때 대기 중인 Viewer 업데이트를 다시 확인합니다.',unverified:'창 실행을 아직 확인하지 못했습니다. 열린 창을 확인해 주세요.',
    failed:'등록 창을 열지 못했습니다. 이 Mac의 AgentsToZ 업데이트와 실행 상태를 확인한 뒤 다시 시도해 주세요.'},
  en:{title:'Device registration and feature approval',description:'Register devices and choose features, including screen viewing and control, in one place. Check conversation membership and feature registration separately.',
    button:'Open registration guide',opening:'Opening window…',next:'In AgentsToZ Viewer, choose “커뮤니티 기기 등록·승인…”, then select features and request or review registration. Select and approve Mac device trust explicitly.',
    checking:'Checking the Mac registration window…',unsupported:'This device does not support the Mac registration window. Continue in the AgentsToZ Mac app.',
    unknown:'The registration window state could not be verified. Opening is blocked until the next successful check.',
    'other-instance':'AgentsToZ Viewer is running from another location. Finish its current connection, then quit that app completely.',
    'update-waiting':'A Viewer update is waiting. Finish the current connection, quit Viewer completely, then open it here again.',
    missing:'The registration window is unavailable in this Mac app. Update AgentsToZ and check again.',available:'The registration guide can open. Check registration and approval in that window.',
    pending:'Opening will check the pending Viewer update again.',unverified:'The window has not been confirmed running yet. Check the opened window.',
    failed:'The registration window could not open. Check this Mac’s AgentsToZ update and running apps, then try again.'},
} as const;
type Copy=typeof messages.ko|typeof messages.en;

/** This is a desktop-native entry, not the mobile/portal registration flow. No hidden or browser hook is mounted. */
export function CommunityDeviceRegistration({visible=true}:{visible?:boolean}){
  return visible&&isTauri()?<VisibleRegistrationEntry/>:null;
}
function VisibleRegistrationEntry(){
  const [language]=useAppLanguage(),copy=language==='ko'?messages.ko:messages.en;
  return <section className="community-device-registration" data-testid="community-device-registration" aria-label={copy.title}>
    <div className="community-device-registration__intro"><h3>{copy.title}</h3><p>{copy.description}</p></div>
    <NativeRegistrationEntry copy={copy}/>
  </section>;
}
function NativeRegistrationEntry({copy}:{copy:Copy}){
  const viewer=useViewerHelper(copy.unverified),state=communityRegistrationEntryState(true,viewer.status,viewer.statusFailed);
  const canOpen=state==='available'&&!viewer.opening;
  return <div className="community-device-registration__controls" data-entry-state={state}>
    <p role="status" className="community-device-registration__state">{copy[state==='browser'?'unknown':state]}</p>
    {viewer.status?.updatePending&&state==='available'&&<p className="community-device-registration__state">{copy.pending}</p>}
    {state!=='unsupported'&&state!=='missing'&&<button type="button" className="community-device-registration__open" disabled={!canOpen} onClick={()=>{if(canOpen)void viewer.open();}}>{viewer.opening?copy.opening:copy.button}</button>}
    <p className="community-device-registration__next">{copy.next}</p>
    {viewer.note&&<p role="status" className="community-device-registration__state">{viewer.note}</p>}
    {viewer.error&&<p role="alert" className="community-device-registration__error">{copy.failed}</p>}
  </div>;
}
