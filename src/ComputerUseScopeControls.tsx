import {useState} from 'react';
import type {ComputerScopeApplication,ComputerUseScope} from './computerUseScopeProtocol';
import type {ComputerUseManagementRequester} from './computerUseClient';

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
  const title=mode==='desktop'?'이 Mac 전체를 AI에 맡기기':'선택한 앱을 AI에 맡기기';
  const blocked=!supported||!permissionsReady||(mode==='application'&&!selected)||activeLegacy;
  return <section className="mt-5" aria-label={title}><h3 className="font-semibold">{title}</h3>
    <p className="mt-2 text-sm text-[var(--text-muted)]">{mode==='desktop'?'켜 두면 AI가 이 Mac의 여러 화면과 앱에서 화면 보기·마우스·키보드 작업을 요청할 수 있습니다.':'켜 두면 AI가 선택한 앱의 여러 창에서 화면 보기·마우스·키보드 작업을 요청할 수 있습니다. 앱을 다시 실행하거나 업데이트하면 다시 켜야 합니다.'}</p>
    {mode==='desktop'&&standing
      ?<p className="mt-2 text-xs text-[var(--text-muted)]" data-testid="computer-use-standing">상시 허용 켜짐({standing.toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'numeric',minute:'2-digit'})}부터): 이 Mac의 모든 AgentsToZ AI가 다시 묻지 않고 전체 Mac을 씁니다. 커뮤니티의 다른 Mac에서 맡긴 작업도 이 Mac의 AI가 하므로 그대로 이어집니다. 앱·Control을 다시 시작하거나 업데이트해도 유지되고, 끄거나 Control 막대의 「중단」을 누르면 상시 허용도 꺼집니다.</p>
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
export function ComputerUseScopeGrants({state,busy,run,request,refresh}:{state:Record<string,any>|null;busy:boolean;run:(action:()=>Promise<void>)=>Promise<void>;request:ComputerUseManagementRequester;refresh:()=>Promise<void>}){
  const [reviewed,setReviewed]=useState<Record<string,boolean>>({});const scoped=state?.scoped;
  return <>
    {!!scoped?.grants?.length&&<section className="mt-5" aria-label="전체 Mac·앱 제어 허용"><h3 className="font-semibold">현재 범위 허용</h3>{scoped.grants.map((g:any)=><div key={g.id} className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-[var(--line)] p-3"><div className="min-w-0"><p className="break-words text-sm">{g.label}</p><p className="break-words text-xs text-[var(--text-muted)]">{g.scope?.kind==='desktop'?'전체 Mac':g.scope?.application?.bundleId} · 화면·마우스·키보드 · {g.halted?'중지됨':g.owner==='person'?'직접 사용 중 · Control 막대에서 「AI에게 넘기기」':'AI가 사용 중 · 끌 때까지 유지'}</p></div><button type="button" className={button+' shrink-0'} disabled={busy} onClick={()=>void run(async()=>{await request({operation:'scope-revoke',id:g.id});await refresh();})}>제어 종료</button></div>)}</section>}
    {!!scoped?.recovery?.length&&<section className="mt-5" aria-label="범위 제어 결과 확인 필요"><h3 className="font-semibold">결과를 확인할 범위 작업</h3><p className="mt-1 text-sm text-[var(--text-muted)]">현재 화면과 작업 결과를 직접 확인한 뒤 검토해 주세요. 자동으로 재실행하지 않습니다.</p>{scoped.recovery.map((r:any)=><div key={r.id} className="mt-2 rounded-xl border border-[var(--line)] p-3"><p className="break-words text-sm">{r.scopeKind==='desktop'?'전체 Mac':r.bundleId} · {r.operation}</p><label className="mt-2 flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={reviewed[r.id]===true} onChange={e=>setReviewed(v=>({...v,[r.id]:e.target.checked}))}/>현재 작업 결과를 직접 확인했습니다</label><button type="button" className={button} disabled={busy||reviewed[r.id]!==true} onClick={()=>void run(async()=>{await request({operation:'scope-review-recovery',id:r.id,confirmed:true});await refresh();})}>범위 작업 검토 완료</button></div>)}</section>}
  </>;
}
