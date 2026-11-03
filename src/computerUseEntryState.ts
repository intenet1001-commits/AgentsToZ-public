import {computerUseRemoteView,supportsComputerScopes} from './ComputerUseScopeControls';

export const COMPUTER_USE_STATUS_MAX_AGE_MS=15_000;
export type ComputerUseStatusPhase='loading'|'current'|'failed';
export type ComputerUseEntryAction='control'|'review'|'scope'|'remote'|'refresh'|'registration';
export interface ComputerUseEntryRow {id:'local'|'standing'|'remote'|'registration';title:string;label:string;detail:string;action:ComputerUseEntryAction;button:string;ready:boolean}
export function computerUseStatusCurrent(phase:ComputerUseStatusPhase,checkedAt:number|null,now:number):boolean{
  return phase==='current'&&checkedAt!==null&&Number.isFinite(checkedAt)&&Number.isFinite(now)&&checkedAt<=now&&now-checkedAt<COMPUTER_USE_STATUS_MAX_AGE_MS;
}
const row=(id:ComputerUseEntryRow['id'],title:string,label:string,detail:string,action:ComputerUseEntryAction,button:string,ready=false):ComputerUseEntryRow=>({id,title,label,detail,action,button,ready});
/** Display evidence only; every existing action still repeats its own native admission checks. */
export function computerUseEntryRows(state:Record<string,any>|null,current:boolean,now:number,loading=false):ComputerUseEntryRow[]{
  const registration=row('registration','커뮤니티 기능 등록','등록 창에서 확인','대화 참여와 기능 등록은 별도입니다. 사용할 기능의 등록·승인 상태는 Viewer에서 확인하세요.','registration','등록·승인 경로 보기');
  if(!current||state?.success!==true){
    const label=loading?'확인 중':'현재 상태 확인 필요',detail=loading?'현재 연결과 권한을 읽고 있습니다.':'마지막 조회 결과로 켜짐이나 준비 완료를 판단하지 않습니다. 상태를 다시 확인하세요.';
    return [row('local','이 Mac의 AI',label,detail,'refresh','상태 다시 확인'),row('standing','상시 허용',label,detail,'control','Control에서 확인'),row('remote','다른 Mac의 AI 받기',label,detail,'refresh','상태 다시 확인'),registration];
  }
  const native=state.native,scoped=state.scoped?.native,scopes=supportsComputerScopes(state),v=computerUseRemoteView(state,now),access=state.access;
  const pending=[...(Array.isArray(state.pending)?state.pending:[]),...(Array.isArray(state.scoped?.pending)?state.scoped.pending:[])].some(p=>typeof p?.expiresAt!=='number'||p.expiresAt>now);
  const permissions=native?.success===true&&native.accessibility===true&&(!state.scoped||scopes&&scoped.accessibility===true&&scoped.screenRecording===true);
  let local:ComputerUseEntryRow;
  if(state.restartRequired===true)local=row('local','이 Mac의 AI','연결 다시 시작 필요','기존 연결이 종료됐습니다. 결과가 불명인 작업을 확인하고 AgentsToZ를 다시 실행하세요.','control','Control 열기');
  else if(native?.success!==true)local=row('local','이 Mac의 AI','도우미 준비 필요','AgentsToZ Control의 연결 상태를 확인하세요.','control','Control 열기');
  else if(!permissions)local=row('local','이 Mac의 AI','권한 준비 필요','Control을 열고 손쉬운 사용·선택 범위의 화면 기록 권한을 직접 확인하세요.','control','Control 열기');
  else if(native.secureInput===true||scoped?.secureInput===true)local=row('local','이 Mac의 AI','보안 입력 중','암호 등 보안 입력을 마친 뒤 상태를 다시 확인하세요.','refresh','상태 다시 확인');
  else if(pending)local=row('local','이 Mac의 AI','승인 대기','AI의 요청이 도착했습니다. Control에서 대상과 범위를 직접 확인하세요.','review','승인 검토 열기');
  else if(access?.enabled===true)local=row('local','이 Mac의 AI','요청 수신 켜짐','선택한 범위에서 AI 요청을 받습니다. 실제 허용과 사용 상태는 아래에서 확인하세요.','scope','사용 범위 확인',true);
  else local=row('local','이 Mac의 AI','사용 범위 선택 필요','아래에서 전체 Mac·선택한 앱·한 창 중 사용할 범위를 확인하세요.','scope','사용 범위 보기');
  const standingSince=access?.standing?.since,standingKnown=scopes&&scoped?.success===true&&Number.isSafeInteger(standingSince)&&standingSince>=0&&standingSince<=now;
  const standing=standingKnown
    ?row('standing','상시 허용','켜짐','Control에서 승인한 전체 Mac 상시 허용이 있습니다. 다른 Mac의 수신 준비는 별도로 확인하세요.','control','Control에서 확인',true)
    :scoped?.success===true&&scoped.standing===null
      ?row('standing','상시 허용','꺼짐','반복 승인을 줄이려면 Control 메뉴의 「상시 허용 켜기…」를 직접 선택하세요. 이 버튼은 자동으로 켜지 않습니다.','control','Control에서 확인')
      :row('standing','상시 허용','상태 확인 필요','Control에서 현재 상시 허용 상태를 확인하세요. 이 화면은 허용을 새로 만들지 않습니다.','control','Control에서 확인');
  let remote:ComputerUseEntryRow;
  if(!v||v.unreadable)remote=row('remote','다른 Mac의 AI 받기','수신 상태 확인 필요','현재 수신 설정을 확인하지 못했습니다. 상태를 다시 확인하고 Control의 수신 동의를 확인하세요.','refresh','상태 다시 확인');
  else if(!v.allowRemote)remote=row('remote','다른 Mac의 AI 받기','꺼짐','다른 Mac의 AI 수신 설정이 꺼져 있습니다. 변경하려면 아래 수신 설정을 직접 확인하세요.','remote','수신 설정 보기');
  else if(v.receptionReview==='pending')remote=row('remote','다른 Mac의 AI 받기','승인 대기','공통 권한관리의 수신 복구 인증을 기다리고 있습니다.','control','Control에서 확인');
  else if(!v.accepting&&v.nativeAuthorized!==false)remote=row('remote','다른 Mac의 AI 받기','켜짐 · 받을 준비 필요','서명된 Mac 앱의 수신 연결을 확인하세요.','control','Control 열기');
  else if(v.profileReady===false)remote=row('remote','다른 Mac의 AI 받기','켜짐 · 받을 준비 필요','아젠투지 설정에서 공유 총괄 폴더 연결을 확인한 뒤 다시 조회하세요.','refresh','연결 확인 후 다시 확인');
  else if(!v.standing||v.appScope)remote=row('remote','다른 Mac의 AI 받기','켜짐 · 받을 준비 필요',v.appScope?'지금은 한 앱 범위입니다. 다른 Mac의 AI 수신에는 기존 전체 Mac 상시 허용이 필요합니다.':'Control의 전체 Mac 상시 허용을 직접 확인하세요. 수신 설정만 켜져 있어서는 요청을 받지 않습니다.','control','상시 허용 확인');
  else if(v.nativeAuthorized===false)remote=row('remote','다른 Mac의 AI 받기','켜짐 · 받을 준비 필요','현재 공통 기능 동의와 이 Mac의 수신 권한을 확인해야 합니다.','registration','등록·승인 경로 보기');
  else if(!permissions||state.restartRequired===true||!v.accepting)remote=row('remote','다른 Mac의 AI 받기','켜짐 · 받을 준비 필요','현재 Mac 앱·Control 연결과 필요한 권한을 확인하세요.','control','Control 열기');
  else if(v.nativeAuthorized!==true||v.profileReady!==true)remote=row('remote','다른 Mac의 AI 받기','수신 권한 확인 필요','설정은 켜져 있지만 현재 기능 동의나 공유 연결을 확인하지 못했습니다.','refresh','상태 다시 확인');
  else if(native.secureInput===true||scoped?.secureInput===true)remote=row('remote','다른 Mac의 AI 받기','보안 입력 중','보안 입력을 마친 뒤 상태를 다시 확인하세요.','refresh','상태 다시 확인');
  else remote=row('remote','다른 Mac의 AI 받기','받을 준비됨','현재 수신 동의·공유 연결·전체 Mac 상시 허용이 확인됐습니다. 실제 요청은 기존 허용 범위에서 검사합니다.','remote','수신 설정 보기',true);
  return [local,standing,remote,registration];
}
