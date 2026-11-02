import {useState} from 'react';
import type {ComputerScopeApplication,ComputerUseScope} from './computerUseScopeProtocol';
import type {ComputerUseManagementRequest,ComputerUseManagementRequester} from './computerUseClient';

export type ComputerUseMode='desktop'|'application'|'window';
export interface ComputerUseAppChoice {name:string;application:ComputerScopeApplication}
const button='min-h-11 rounded-lg border border-[var(--line)] px-3 text-sm';
const field='mt-1 min-h-11 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 text-base';
export function supportsComputerScopes(state:Record<string,any>|null){
  const native=state?.scoped?.native;
  return native?.success===true&&native.scopeProtocolVersion===2&&Array.isArray(native.operations)
    && ['scope-observe','scope-capture','scope-click','scope-key','scope-type-text'].every(op=>native.operations.includes(op));
}
export function ComputerUseModeSelector({mode,onChange,available,reason,locked=false}:{mode:ComputerUseMode;onChange:(mode:ComputerUseMode)=>void;available:boolean;reason?:unknown;locked?:boolean}){
  return <fieldset className="mt-5"><legend className="text-sm font-semibold">제어 범위</legend>
    <div className="mt-2 flex flex-wrap gap-2">{([['desktop','전체 Mac'],['application','선택한 앱'],['window','한 창']] as const).map(([value,label])=><label key={value} className={button+' flex cursor-pointer items-center gap-2 px-3'}><input type="radio" name="computer-use-scope" value={value} checked={mode===value} disabled={locked||value!=='window'&&!available} onChange={()=>onChange(value)}/>{label}</label>)}</div>
    {locked&&<p className="mt-2 text-xs text-[var(--text-muted)]">범위를 바꾸려면 먼저 컴퓨터 유즈를 끄세요.</p>}
    {!available&&<p className="mt-2 text-xs text-[var(--text-muted)]">{reason==='scope-update-required'?'이 Mac의 AgentsToZ Control이 이전 버전입니다. 최신 Control을 설치해야 전체 Mac·앱별 제어를 쓸 수 있습니다. 기존 한 창 제어는 계속 사용할 수 있습니다.':'전체 Mac·앱별 제어 상태를 확인해 주세요. 상태 다시 확인을 누르면 연결과 권한을 새로 확인합니다.'}</p>}
  </fieldset>;
}
/**
 * The person's switch. While on, an AI may ask for this scope and Control asks the person (Touch ID or password) for
 * each request; there is no connection to pick. Off ends every grant and waiting request at once.
 */
export function ComputerUseScopeForm({mode,state,applications,request,refresh,busy,run,onNotice}:{mode:'desktop'|'application';state:Record<string,any>|null;applications:ComputerUseAppChoice[];request:ComputerUseManagementRequester;refresh:()=>Promise<void>;busy:boolean;run:(action:()=>Promise<void>)=>Promise<void>;onNotice:(value:string)=>void}){
  const [applicationKey,setApplicationKey]=useState('');
  const selected=applications.find(a=>`${a.application.pid}/${a.application.processStart}`===applicationKey);
  const access=state?.access,on=access?.enabled===true,standing=Number.isSafeInteger(access?.standing?.since)?new Date(access.standing.since):null;
  const supported=supportsComputerScopes(state),permissionsMissing=state?.scoped?.native?.accessibility!==true||state?.scoped?.native?.screenRecording!==true,permissionsReady=state?.restartRequired!==true&&!permissionsMissing&&state?.scoped?.native?.secureInput!==true,activeLegacy=!!state?.grants?.some((g:any)=>!g.halted);
  const onScope=on?(access.scope?.kind==='desktop'?'전체 Mac':applications.find(a=>a.application.pid===access.scope?.application?.pid&&a.application.processStart===access.scope?.application?.processStart)?.name??access.scope?.application?.bundleId):'';
  const title=mode==='desktop'?'이 Mac 전체를 AI에 맡기기':'선택한 앱을 AI에 맡기기',remote=computerUseRemoteView(state);
  const blocked=!supported||!permissionsReady||(mode==='application'&&!selected)||activeLegacy;
  return <section className="mt-5" aria-label={title}><h3 className="font-semibold">{title}</h3>
    <p className="mt-2 text-sm text-[var(--text-muted)]">{mode==='desktop'?'켜 두면 AI가 이 Mac의 여러 화면과 앱에서 화면 보기·마우스·키보드 작업을 요청할 수 있습니다.':'켜 두면 AI가 선택한 앱의 여러 창에서 화면 보기·마우스·키보드 작업을 요청할 수 있습니다. 앱을 다시 실행하거나 업데이트하면 다시 켜야 합니다.'}</p>
    {mode==='desktop'&&standing
      ?<p className="mt-2 text-xs text-[var(--text-muted)]" data-testid="computer-use-standing">상시 허용 켜짐({standing.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'})}부터): {computerUseStandingWho(remote)} 앱·Control을 다시 시작하거나 업데이트해도 유지되고, 끄거나 Control 막대의 「중단」을 누르면 상시 허용도 꺼집니다.</p>
      :<p className="mt-2 text-xs text-[var(--text-muted)]">AI가 요청할 때마다 Control에서 직접 인증하며, 승인은 끌 때까지 유지됩니다(앱·Control을 다시 실행하거나 그 AI 연결이 끝나도 끝납니다). 끄면 모든 허용과 대기 중인 요청이 바로 끝납니다. 앱을 다시 실행하면 꺼집니다. 시스템 인증과 Control 자체 승인 화면은 직접 처리합니다.{mode==='desktop'&&' 매번 승인하지 않으려면 Control 승인 화면의 「항상 허용…」이나 메뉴 막대 Control의 「상시 허용 켜기…」를 누르세요(Touch ID 한 번).'}</p>}
    {supported&&!permissionsReady&&state?.restartRequired!==true&&<p role="status" className="mt-2 text-sm">{permissionsMissing?'위의 「권한 켜기」를 누르고, 열리는 시스템 설정에서 AgentsToZ Control 스위치만 켜세요.':'보안 입력(암호 입력란 등)을 마친 뒤 상태 다시 확인을 누르세요.'}</p>}
    {activeLegacy&&!on&&<p role="status" className="mt-2 text-sm">현재 한 창 허용을 먼저 종료한 뒤 켜 주세요.</p>}
    <div className="mt-3 grid gap-3">
      {mode==='application'&&!on&&<label className="text-sm">허용할 앱<select aria-label="허용할 앱" className={field} value={applicationKey} onChange={e=>setApplicationKey(e.target.value)}><option value="">실행 중인 앱 선택</option>{applications.map(a=><option key={`${a.application.pid}/${a.application.processStart}`} value={`${a.application.pid}/${a.application.processStart}`}>{a.name} · {a.application.bundleId}</option>)}</select></label>}
      {mode==='application'&&!on&&applications.length===0&&<p className="text-xs text-[var(--text-muted)]">허용할 앱을 실행한 뒤 상태 다시 확인을 누르세요.</p>}
      <button type="button" role="switch" aria-checked={on} aria-label="컴퓨터 유즈" data-testid="computer-use-access-switch" disabled={busy||(!on&&blocked)}
        className={button+' flex items-center justify-between gap-3 '+(on?'border-[var(--accent)] bg-[var(--accent-soft)]':'')} onClick={()=>void run(async()=>{
          if(on){await request({operation:'scope-access-set',enabled:false});onNotice(standing?'컴퓨터 유즈와 상시 허용을 껐습니다. 모든 허용과 대기 중인 요청을 끝냈습니다.':'컴퓨터 유즈를 껐습니다. 모든 허용과 대기 중인 요청을 끝냈습니다.');}
          else{
            const scope:ComputerUseScope=mode==='desktop'?{kind:'desktop'}:{kind:'application',application:selected!.application};
            await request({operation:'scope-access-set',enabled:true,scope});
            onNotice('켰습니다. AI가 요청하면 아래 「승인 대기」에 나타나고, Control에서 직접 인증해야 시작됩니다.');
          }
          await refresh();
        })}><span>컴퓨터 유즈</span><span className="font-semibold">{on?'켜짐':'꺼짐'}</span></button>
      <p className="text-xs text-[var(--text-muted)]" data-testid="computer-use-access-state">{on?`켜짐 · ${onScope} · ${standing&&access.scope?.kind==='desktop'?'상시 허용 · AI 요청을 바로 허용합니다.':'AI의 요청을 받습니다.'}`:'꺼짐 · AI의 컴퓨터 유즈 요청을 받지 않습니다.'}</p>
    </div>
  </section>;
}
/**
 * This Mac's whole-Mac and app grants. A grant held by another Mac's AI is shown in its remote row instead (「끊기」 and
 * 「이 기기의 AI 막기」 there): ending only the grant would let that AI take it again at once under the standing allowance.
 */
export function ComputerUseScopeGrants({state,busy,run,request,refresh}:{state:Record<string,any>|null;busy:boolean;run:(action:()=>Promise<void>)=>Promise<void>;request:ComputerUseManagementRequester;refresh:()=>Promise<void>}){
  const [reviewed,setReviewed]=useState<Record<string,boolean>>({});const scoped=state?.scoped;
  const remoteIds=new Set(computerUseRemoteView(state)?.rows.map(r=>r.connectionId)??[]);
  const grants:any[]=(Array.isArray(scoped?.grants)?scoped.grants:[]).filter((g:any)=>!remoteIds.has(g?.caller?.sessionId));
  return <>
    {!!grants.length&&<section className="mt-5" aria-label="전체 Mac·앱 제어 허용"><h3 className="font-semibold">현재 범위 허용</h3>{grants.map((g:any)=><div key={g.id} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] p-3"><div className="min-w-0"><p className="break-words text-sm">{g.label}</p><p className="break-words text-xs text-[var(--text-muted)]">{g.scope?.kind==='desktop'?'전체 Mac':g.scope?.application?.bundleId} · 화면·마우스·키보드 · {g.halted?'중지됨':g.owner==='person'?'직접 사용 중 · Control 막대에서 「AI에게 넘기기」':'AI가 사용 중 · 끌 때까지 유지'}</p></div><button type="button" className={button+' shrink-0'} disabled={busy} onClick={()=>void run(async()=>{await request({operation:'scope-revoke',id:g.id});await refresh();})}>제어 종료</button></div>)}</section>}
    {!!scoped?.recovery?.length&&<section className="mt-5" aria-label="범위 제어 결과 확인 필요"><h3 className="font-semibold">결과를 확인할 범위 작업</h3><p className="mt-1 text-sm text-[var(--text-muted)]">현재 화면과 작업 결과를 직접 확인한 뒤 검토해 주세요. 자동으로 재실행하지 않습니다.</p>{scoped.recovery.map((r:any)=><div key={r.id} className="mt-2 rounded-xl border border-[var(--line)] p-3"><p className="break-words text-sm">{r.scopeKind==='desktop'?'전체 Mac':r.bundleId} · {r.operation}</p><label className="mt-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={reviewed[r.id]===true} onChange={e=>setReviewed(v=>({...v,[r.id]:e.target.checked}))}/>현재 작업 결과를 직접 확인했습니다</label><button type="button" className={button} disabled={busy||reviewed[r.id]!==true} onClick={()=>void run(async()=>{await request({operation:'scope-review-recovery',id:r.id,confirmed:true});await refresh();})}>범위 작업 검토 완료</button></div>)}</section>}
  </>;
}

// ---- Another Mac's AI on this Mac, and this Mac's AI on another Mac (docs/design/remote-computer-use-2026-11-01 §6, §7.9) ----
const DEVICE_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,CONNECTION_TAG=/^[a-f0-9]{32}$/;
/** A name or code from the status for display: no control or format characters (names are the sender's own claim). */
const shown=(value:unknown,max:number)=>typeof value==='string'?Array.from(value.replace(/[\p{Cc}\p{Cf}]/gu,'').replace(/\s+/g,' ').trim()).slice(0,max).join(''):'';
const moment=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?value:null;
const when=(ms:number)=>new Date(ms).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'});
/** 「1호를」·「3호를」·「사무실을」: the object particle after a name; 「을(를)」 when the last character does not tell. */
export function objectParticle(name:string){
  const last=Array.from(name.trim()).at(-1)??'',code=last.codePointAt(0)??0;
  if(code>=0xac00&&code<=0xd7a3)return (code-0xac00)%28===0?'를':'을';
  if(/[0-9]/.test(last))return '013678'.includes(last)?'을':'를';
  return '을(를)';
}
type RemoteRun={busy:boolean;run:(action:()=>Promise<void>)=>Promise<void>;request:ComputerUseManagementRequester;refresh:()=>Promise<void>;onNotice:(value:string)=>void};
type RemoteSet=Omit<Extract<ComputerUseManagementRequest,{operation:'scope-remote-set'}>,'operation'>;
export type ComputerUseRemoteGrantState='agent'|'person'|'halted';
export interface ComputerUseRemoteRow {connectionId:string;code:string;deviceId:string;deviceName:string;deviceCode:string;connection:string;grant:{id:string;state:ComputerUseRemoteGrantState}|null}
export interface ComputerUseRemoteView {
  nativeAuthorized:boolean|null;restorationSupported:boolean;receptionReview:string|null;accepting:boolean;allowRemote:boolean;unreadable:boolean;profileReady:boolean|null;noticeShown:boolean;standing:boolean;appScope:boolean;
  rows:ComputerUseRemoteRow[];blockedDevices:{deviceId:string;name:string;since:number|null}[];
  /** Connections cut with 「끊기」, grouped by a device that is not blocked as a whole. */
  blockedConnections:{deviceId:string;name:string|null;count:number;until:number}[];
  /** 「이제 다른 Mac의 AI도 받습니다 · 막기」 until the person answers it once (D1). */
  noticeDue:boolean;
}
/**
 * The receiving side's part of the management status (§6 WP7): the person's settings and one row per connection of an AI on
 * another Mac with the grant it holds. Null for a host from before remote computer use (no `remote`). A row without a
 * valid device or connection tag is left out: its buttons could not name what to cut or block.
 */
export function computerUseRemoteView(state:Record<string,any>|null):ComputerUseRemoteView|null{
  const r=state?.remote;if(!r||typeof r!=='object'||typeof r.allowRemote!=='boolean')return null;
  const grants:any[]=Array.isArray(state?.scoped?.grants)?state!.scoped.grants:[],rows:ComputerUseRemoteRow[]=[];
  for(const c of Array.isArray(state?.connections)?state!.connections:[]){
    const remote=c?.remote;
    if(c?.scope!=='remote-connection'||typeof c.id!=='string'||!remote||typeof remote.deviceId!=='string'||!DEVICE_ID.test(remote.deviceId)
      ||typeof remote.connection!=='string'||!CONNECTION_TAG.test(remote.connection))continue;
    const held=grants.filter(g=>g?.caller?.sessionId===c.id&&typeof g.id==='string'),g=held.find(g=>!g.halted)??held[0];
    rows.push({connectionId:c.id,code:shown(c.code,8),deviceId:remote.deviceId,deviceName:shown(remote.deviceName,24)||'이름 없음',deviceCode:shown(remote.deviceCode,4)||remote.deviceId.slice(0,4),
      connection:remote.connection,grant:g?{id:g.id,state:g.halted?'halted':g.owner==='person'?'person':'agent'}:null});
  }
  const blockedDevices=(Array.isArray(r.blockedDevices)?r.blockedDevices:[]).filter((d:any)=>typeof d?.deviceId==='string'&&DEVICE_ID.test(d.deviceId))
    .map((d:any)=>({deviceId:d.deviceId as string,name:shown(d.name,24)||'이름 없음',since:moment(d.since)}));
  const whole=new Set(blockedDevices.map((d:{deviceId:string})=>d.deviceId)),cut=new Map<string,{deviceId:string;name:string|null;count:number;until:number}>();
  for(const b of Array.isArray(r.blockedConnections)?r.blockedConnections:[]){
    const until=moment(b?.until);if(typeof b?.deviceId!=='string'||!DEVICE_ID.test(b.deviceId)||until===null||whole.has(b.deviceId))continue;
    const seen=cut.get(b.deviceId);
    cut.set(b.deviceId,{deviceId:b.deviceId,name:seen?.name??rows.find(x=>x.deviceId===b.deviceId)?.deviceName??null,count:(seen?.count??0)+1,until:Math.max(seen?.until??0,until)});
  }
  const access=state?.access,accepting=r.accepting===true,unreadable=r.settingsUnreadable===true,noticeShown=r.noticeShown===true;
  return {nativeAuthorized:typeof r.nativeAuthorized==='boolean'?r.nativeAuthorized:null,restorationSupported:r.restorationSupported===true,receptionReview:typeof r.receptionReview?.state==='string'?r.receptionReview.state:null,accepting,allowRemote:r.allowRemote,unreadable,profileReady:typeof r.profileReady==='boolean'?r.profileReady:null,noticeShown,
    standing:Number.isSafeInteger(access?.standing?.since),appScope:access?.enabled===true&&access.scope?.kind==='application',
    rows,blockedDevices,blockedConnections:[...cut.values()],noticeDue:accepting&&!unreadable&&r.allowRemote&&!noticeShown};
}
/** Who the standing allowance lets in, as D1 decided (2026-11-01): this Mac's AIs, and other Macs' AIs while received. */
export function computerUseStandingWho(remote:ComputerUseRemoteView|null){
  if(!remote||!remote.accepting)return '이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac을 씁니다.';
  return remote.allowRemote&&!remote.unreadable
    ?'이 Mac의 모든 AgentsToZ AI와 같은 커뮤니티 다른 Mac의 AI가 다시 묻지 않고 전체 Mac을 씁니다(다른 Mac의 AI는 아래 「다른 Mac의 AI 받기」로 막을 수 있습니다).'
    :'이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac을 씁니다. 다른 Mac의 AI는 막아 두었습니다.';
}
/** The receiving switch's state line: why nothing of another Mac arrives, or that it does. */
export function computerUseRemoteStateText(v:ComputerUseRemoteView){
  if(v.nativeAuthorized===false)return '받을 수 없음 · 현재 공통 등록의 AI 통신 동의와 Control의 기존 전체 Mac 상시 허용을 확인하세요. Native 권한 확인 전에는 다른 Mac의 AI를 받지 않습니다.';
  if(!v.accepting)return '받을 수 없음 · 이 앱은 다른 Mac의 AI를 받지 않습니다(서명된 macOS 설치 앱에서만 받습니다).';
  if(v.unreadable)return '꺼짐 · 설정 파일을 읽지 못해 다른 Mac의 AI를 받지 않습니다. 공통 등록·권한관리에서 Native 수신 상태를 확인하세요.';
  if(!v.allowRemote)return '꺼짐 · 다른 Mac의 AI를 받지 않습니다. 이 Mac의 AI는 그대로 씁니다.';
  if(v.profileReady===false)return '받을 수 없음 · 공유 총괄 폴더 연결이 필요합니다(아젠투지 설정). 연결이 없으면 다른 Mac의 요청이 이 Mac에 닿지 않습니다.';
  if(!v.standing)return '켜짐 · 상시 허용이 꺼져 있어 아직 받지 않습니다. 메뉴 막대 Control의 「상시 허용 켜기…」로 켜면 받습니다. 여기에 승인 요청이 뜨지는 않습니다.';
  if(v.appScope)return '켜짐 · 지금은 한 앱만 허용돼 있어 다른 Mac의 AI는 거절합니다.';
  return '켜짐 · 같은 커뮤니티 다른 Mac의 AI가 상시 허용 아래 이 Mac 전체를 씁니다. 여기서 다시 묻지 않습니다.';
}
const GRANT_TEXT:Record<ComputerUseRemoteGrantState,string>={agent:'AI가 사용 중 · 전체 Mac',person:'직접 사용 중 · Control 막대에서 「AI에게 넘기기」',halted:'중지됨'};
function remoteSet(p:RemoteRun,body:RemoteSet,notice:string){
  return p.run(async()=>{const response=await p.request({operation:'scope-remote-set',...body});p.onNotice(response.restorationPending?'공통 권한관리 복구 인증을 기다리는 중입니다. 평소 연결에는 인증을 다시 요구하지 않습니다.':notice);await p.refresh();});
}
/**
 * Once after the update (D1): this Mac now lets the community's other Macs in under its standing allowance. Shown until
 * the person answers it — 「확인」 or 「막기」 — so closing the panel does not count as having read it.
 */
export function ComputerUseRemoteNotice({state,...p}:{state:Record<string,any>|null}&RemoteRun){
  const v=computerUseRemoteView(state);if(!v?.noticeDue)return null;
  return <section className="mt-4 rounded-xl border border-[var(--accent)] bg-[var(--accent-soft)] p-3" aria-label="다른 Mac의 AI 안내" data-testid="computer-use-remote-notice">
    <h3 className="font-semibold">{v.standing?'이제 다른 Mac의 AI도 받습니다':'이제 다른 Mac의 AI도 받을 수 있습니다'}</h3>
    <p className="mt-1 text-sm">{v.standing?'상시 허용이 켜져 있어 같은 커뮤니티 다른 Mac의 AI가 묻지 않고 이 Mac 전체를 씁니다.':'Control에서 상시 허용을 켜면 같은 커뮤니티 다른 Mac의 AI가 묻지 않고 이 Mac 전체를 씁니다.'} 쓰기 시작하면 커뮤니티 방에 알림 글이 올라오고 Control 막대에 「AI가 사용 중」이 보입니다. 원하지 않으면 막으세요. 이 Mac의 AI는 그대로 씁니다.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <button type="button" className={button} data-testid="computer-use-remote-notice-block" disabled={p.busy} onClick={()=>void remoteSet(p,{allowRemote:false,noticeShown:true},'다른 Mac의 AI를 막았습니다. 공통 권한관리에서 명시적으로 복구할 수 있습니다.')}>막기</button>
      <button type="button" className={button} data-testid="computer-use-remote-notice-ok" disabled={p.busy} onClick={()=>void remoteSet(p,{noticeShown:true},'확인했습니다. 아래 「다른 Mac의 AI」에서 언제든 막을 수 있습니다.')}>확인</button>
    </div>
  </section>;
}
/**
 * 「다른 Mac의 AI」 on the receiving Mac (§7.9): the receiving switch, a row per connection of another Mac's AI with
 * 「끊기」 (that connection for 30 minutes) and 「이 기기의 AI 막기」 (until unblocked here), and the blocked list. All of
 * it goes through the management route (`scope-remote-set`); turning off or blocking ends those connections at once.
 */
export function ComputerUseRemoteReceive({state,...p}:{state:Record<string,any>|null}&RemoteRun){
  const v=computerUseRemoteView(state);if(!v)return null;
  const on=v.allowRemote&&!v.unreadable,name=(d:{deviceId:string;name?:string|null})=>`${d.name??'기기'} (${d.deviceId.slice(0,4)})`;
  return <section className="mt-5" aria-label="다른 Mac의 AI" data-testid="computer-use-remote">
    <h3 className="font-semibold">다른 Mac의 AI</h3>
    <p className="mt-2 text-sm text-[var(--text-muted)]">같은 커뮤니티의 다른 Mac에 있는 AI가 이 Mac의 상시 허용 아래 전체 Mac만 씁니다. 그 AI는 터미널·AI 앱·스크립트 도구·원격 데스크톱 앱에는 입력하지 않습니다.</p>
    <p className="mt-1 text-xs text-[var(--text-muted)]">오른쪽·두 번 클릭, 스크롤, 끌기도 받습니다. 그 동작이 결과 불명이나 사람 개입으로 끝나면 여기서 결과를 검토할 때까지 이 Mac의 AI 컴퓨터 유즈 전체가 멈춥니다. 멈추려면 Control 막대의 「직접 하기」·「중단」(상시 허용도 꺼짐)이나 아래 「끊기」·「이 기기의 AI 막기」를 쓰세요.</p>
    <div className="mt-3 grid gap-2">
      {v.receptionReview&&<p role="status">권한 복구: {v.receptionReview==='pending'?'사람의 기기 인증을 기다리는 중':v.receptionReview==='approved'?'인증 후 현재 Native 정책 적용됨':'적용을 확인하지 못했습니다. 현재 상태를 다시 확인하세요.'}</p>}
      <button type="button" role="switch" aria-checked={on} aria-label="다른 Mac의 AI 받기" data-testid="computer-use-remote-switch" disabled={p.busy||!v.accepting||!on&&!v.restorationSupported||v.receptionReview==='pending'}
        className={button+' flex items-center justify-between gap-3 '+(on?'border-[var(--accent)] bg-[var(--accent-soft)]':'')}
        onClick={()=>void remoteSet(p,{allowRemote:!on},on?'다른 Mac의 AI를 막았습니다. 쓰던 연결은 모두 끝났습니다. 이 Mac의 AI는 그대로 씁니다.':'다른 Mac의 AI를 다시 받습니다. 상시 허용이 켜져 있을 때만 씁니다.')}>
        <span>다른 Mac의 AI 받기</span><span className="font-semibold">{on?'켜짐':'꺼짐'}</span></button>
      <p className="text-xs text-[var(--text-muted)]" data-testid="computer-use-remote-state">{computerUseRemoteStateText(v)}</p>
      <p className="text-xs text-[var(--text-muted)]">공통 권한관리: 처음 등록한 기존 전체 Mac 상시 허용은 추가 인증 없이 적용합니다. 꺼 두거나 막은 권한을 복구할 때만 이곳에서 사람이 인증합니다. 연결할 때 다시 인증하지 않습니다.</p>
    </div>
    {v.rows.length>0&&<ul className="mt-3 grid gap-2" aria-label="이 Mac을 쓰는 다른 Mac의 AI">{v.rows.map(row=><li key={row.connectionId} data-testid="computer-use-remote-row" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] p-3">
      <div className="min-w-0"><p className="break-words text-sm font-semibold">원격 · {row.deviceName} ({row.deviceCode})</p>
        <p className="break-words text-xs text-[var(--text-muted)]">연결 {row.code} · {row.grant?GRANT_TEXT[row.grant.state]:'연결됨 · 아직 허용 없음'}</p></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button+' shrink-0'} data-testid="computer-use-remote-cut" aria-label={`원격 ${row.deviceName} (${row.deviceCode}) 연결 ${row.code} 끊기 · 30분`} disabled={p.busy}
          onClick={()=>void remoteSet(p,{block:{deviceId:row.deviceId,name:row.deviceName,connection:row.connection,minutes:30}},`원격 ${row.deviceName} (${row.deviceCode})의 이 연결을 끊었습니다. 30분 동안 다시 붙지 않습니다.`)}>끊기</button>
        <button type="button" className={button+' shrink-0'} data-testid="computer-use-remote-block-device" aria-label={`${row.deviceName} (${row.deviceCode})의 AI 막기`} disabled={p.busy}
          onClick={()=>void remoteSet(p,{block:{deviceId:row.deviceId,name:row.deviceName}},`${row.deviceName} (${row.deviceCode})의 AI를 막았습니다. 아래 막은 기기에서 풀 때까지 받지 않습니다.`)}>이 기기의 AI 막기</button>
      </div></li>)}</ul>}
    {(v.blockedDevices.length>0||v.blockedConnections.length>0)&&<div className="mt-3" role="group" aria-label="막은 기기"><p className="text-sm font-semibold">막은 기기</p>
      {v.blockedDevices.map(d=><div key={d.deviceId} data-testid="computer-use-remote-blocked" className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 break-words">{name(d)} · 풀 때까지 막음{d.since!==null?` · ${when(d.since)}부터`:''}</span>
        <button type="button" className={button+' shrink-0'} data-testid="computer-use-remote-unblock" aria-label={`${name(d)} 막기 풀기`} disabled={p.busy||!v.restorationSupported||v.receptionReview==='pending'}
          onClick={()=>void remoteSet(p,{unblock:{deviceId:d.deviceId}},`${name(d)}의 AI를 다시 받습니다.`)}>풀기</button></div>)}
      {v.blockedConnections.map(b=><div key={b.deviceId} data-testid="computer-use-remote-cut-list" className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="min-w-0 break-words">{name(b)} · 끊은 연결 {b.count}개 · {when(b.until)}까지</span>
        <button type="button" className={button+' shrink-0'} data-testid="computer-use-remote-uncut" aria-label={`${name(b)} 끊은 연결 풀기`} disabled={p.busy||!v.restorationSupported||v.receptionReview==='pending'}
          onClick={()=>void remoteSet(p,{unblock:{deviceId:b.deviceId}},`${name(b)}의 끊은 연결을 풀었습니다.`)}>풀기</button></div>)}
    </div>}
  </section>;
}
export interface ComputerUseOutgoingDevice {deviceId:string;deviceName:string;connections:number;clients:string[];since:number;lastCallAt:number;active:boolean}
/** This Mac's AIs on other Macs (`outgoing` in the status, sending side): one row per device. */
export function computerUseOutgoingView(state:Record<string,any>|null):ComputerUseOutgoingDevice[]{
  const out=new Map<string,ComputerUseOutgoingDevice>();
  for(const s of Array.isArray(state?.outgoing)?state!.outgoing:[]){
    const since=moment(s?.since),last=moment(s?.lastCallAt);
    if(typeof s?.deviceId!=='string'||!DEVICE_ID.test(s.deviceId)||since===null||last===null)continue;
    const d=out.get(s.deviceId),client=shown(s.client,20),clients=d?.clients??[];
    out.set(s.deviceId,{deviceId:s.deviceId,deviceName:d?.deviceName??(shown(s.deviceName,24)||'이름 없음'),connections:(d?.connections??0)+1,
      clients:client&&!clients.includes(client)?[...clients,client]:clients,since:Math.min(d?.since??since,since),lastCallAt:Math.max(d?.lastCallAt??last,last),active:d?.active===true||s.active===true});
  }
  return [...out.values()];
}
/** 「이 Mac의 AI가 <기기>를 사용 중」 and its 「끊기」 (A side, §6): the sessions end; the next call of that AI connects again. */
export function ComputerUseOutgoing({state,...p}:{state:Record<string,any>|null}&RemoteRun){
  const devices=computerUseOutgoingView(state);if(!devices.length)return null;
  return <section className="mt-4 rounded-xl border border-[var(--line)] p-3" aria-label="이 Mac의 AI가 다른 Mac을 사용 중" data-testid="computer-use-outgoing">
    <h3 className="font-semibold">이 Mac의 AI가 다른 Mac을 사용 중</h3>
    {devices.map(d=><div key={d.deviceId} data-testid="computer-use-outgoing-row" className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0"><p className="break-words text-sm">이 Mac의 AI가 {d.deviceName}{objectParticle(d.deviceName)} 사용 중</p>
        <p className="break-words text-xs text-[var(--text-muted)]">연결 {d.connections}개{d.clients.length?` · ${d.clients.join(', ')}`:''} · {d.active?'최근 동작':'쉬는 중 · 마지막 동작'} {when(d.lastCallAt)}</p></div>
      <button type="button" className={button+' shrink-0'} data-testid="computer-use-outgoing-close" aria-label={`${d.deviceName} 사용 끊기`} disabled={p.busy}
        onClick={()=>void p.run(async()=>{await p.request({operation:'scope-remote-outgoing-close',deviceId:d.deviceId});p.onNotice(`${d.deviceName} 사용을 끊었습니다. 그 Mac의 허용도 곧(늦어도 75초 안에) 끝납니다. 이 Mac의 AI가 다시 부르면 새로 연결합니다.`);await p.refresh();})}>끊기</button>
    </div>)}
  </section>;
}
