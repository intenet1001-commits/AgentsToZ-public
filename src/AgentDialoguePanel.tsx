import {useCallback,useEffect,useRef,useState} from 'react';
import {invoke,isTauri} from '@tauri-apps/api/core';
import type {AgentDialogueTarget} from './agentDialogueContract';
import {DeviceNameEditor} from './components/DeviceNameEditor';
import {validateDeviceName} from './deviceName';
import {agentDialoguePublishRows,agentDialoguePublishSummary,agentDialogueRowChecked,
  type AgentDialoguePublishIntent,type AgentDialoguePublishRow} from './agentDialoguePublishRows';
import {agentDialoguePairingRows,agentDialoguePairingSummary,
  type AgentDialoguePairingPeer,type AgentDialoguePairingRecord} from './agentDialoguePairingRows';
import {agentDialogueCommunityMemberLabel,agentDialogueCommunityView,
  type AgentDialogueCommunityStatus} from './agentDialogueCommunity';
import {IncrementalListMore,useIncrementalRender} from './components/IncrementalListMore';

interface Status {
  enabled:{target:string;kind:'ops'|'project';portId?:string;endpointId:string;displayName:string}[];
  /** requestedAt/client/connection are absent from a sidecar older than this panel. */
  pending:{id:string;summary:string;expiresAt:string;requestedAt?:string;client?:string|null;connection?:string;source:AgentDialogueTarget;operation:string;roomId:string|null}[];
  remoteRevocationPending:number;
}
const timeOf=(value:string)=>new Date(value).toLocaleTimeString();
/** The UI-only management channel; the approval notice outside this panel uses it too. */
export async function manageAgentDialogue(operation:string,extra:Record<string,unknown>={}){
  if(isTauri()&&String(import.meta.env.DEV)!=='true'){
    const proxied=await invoke<{status:number;body:Record<string,any>}>('agent_dialogue_management_request',
      {body:{operation,...extra}});
    const value=proxied?.body;
    if(!Number.isInteger(proxied?.status)||!value||proxied.status<200||proxied.status>=300||value.success!==true)
      throw new Error(value?.error??'대화 보안 응답을 확인하지 못했습니다.');
    return value;
  }
  const response=await fetch(`${isTauri()?'http://127.0.0.1:3001':''}/api/agent-dialogue/manage`,{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,...extra}),signal:AbortSignal.timeout(20_000),
  });
  const value=await response.json();
  if(!response.ok||value.success!==true)throw new Error(value.error??'대화 연결을 확인하지 못했습니다.');
  return value;
}
export function AgentDialoguePanel({projects,opsProjectId,deviceName,deviceId,onRenameDevice,onClose}:{projects:{id:string;name:string}[];opsProjectId?:string|null;deviceName:string;deviceId:string;onRenameDevice:(name:string)=>Promise<void>;onClose:()=>void}){
  const [status,setStatus]=useState<Status|null>(null),[inFlight,setInFlight]=useState<Map<string,AgentDialoguePublishIntent>>(()=>new Map());
  const [search,setSearch]=useState(''),[confirmOff,setConfirmOff]=useState<string|null>(null),[progress,setProgress]=useState('');
  const bulkStopRequested=useRef(false),[bulkStopping,setBulkStopping]=useState(false),[bulkNotice,setBulkNotice]=useState('');
  const [pairSource,setPairSource]=useState(''),[pairSearch,setPairSearch]=useState(''),[pairBusy,setPairBusy]=useState('');
  const [peerList,setPeerList]=useState<AgentDialoguePairingPeer[]|null>(null);
  const [communityStatus,setCommunityStatus]=useState<AgentDialogueCommunityStatus|null>(null);
  const [communityBusy,setCommunityBusy]=useState(false),[communityError,setCommunityError]=useState('');
  /** 공개된 대상이 하나라도 있으면 이 기기는 이미 동의한 것이다. 사용자가 직접 건드리기 전까지
   *  체크된 상태로 보여 준다 — 40개가 공개 중인데 「동의합니다」가 비어 보이면 고장으로 읽힌다. */
  const consentTouched=useRef(false);
  /** 폴링이 성공하면 지워도 되는 오류와, 사용자가 누른 동작의 오류를 가른다. 예전에는 3초 폴링이
   *  오류를 지우지 않아 몇 분 전에 실패한 문구가 **현재 상태처럼** 남아 있었다(VOC 2026-10-04). */
  const errorFromAction=useRef(false);
  const [pairingList,setPairingList]=useState<AgentDialoguePairingRecord[]|null>(null);
  const [consentChoice,setConsentChoice]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const consent=consentTouched.current?consentChoice:(status?.enabled.length??0)>0||consentChoice;
  const setConsent=(value:boolean)=>{consentTouched.current=true;setConsentChoice(value);};
  const checkedDeviceName=validateDeviceName(deviceName);
  const opsName=checkedDeviceName.ok?`아젠투지(OPS) · ${checkedDeviceName.value}`:'이 기기의 아젠투지(OPS)';
  const targets=[{id:'ops',name:opsName},...projects.filter(project=>project.id!==opsProjectId).map(project=>({id:project.id,name:project.name}))];
  const allPublishRows=agentDialoguePublishRows({targets,enabled:status?.enabled??null,inFlight});
  const publishRows=agentDialoguePublishRows({targets,enabled:status?.enabled??null,inFlight,search});
  const publishSummary=agentDialoguePublishSummary(allPublishRows);
  const closeBlocked=busy||inFlight.size>0||!!pairBusy||communityBusy;
  const {limit:publishLimit,showMore:showMorePublish}=useIncrementalRender(publishRows.length,`agent-dialogue:${search}`);
  const allPairRows=agentDialoguePairingRows({peers:peerList,pairings:pairingList});
  const pairRows=agentDialoguePairingRows({peers:peerList,pairings:pairingList,search:pairSearch});
  const pairSummary=agentDialoguePairingSummary(allPairRows);
  const {limit:pairLimit,showMore:showMorePairs}=useIncrementalRender(pairRows.length,`agent-dialogue-pair:${pairSearch}`);
  const refresh=useCallback(async(clearError=true)=>{
    try{
      const next=await manageAgentDialogue('status');
      setStatus({enabled:next.enabled??[],pending:next.pending??[],remoteRevocationPending:next.remoteRevocationPending??0});
      // 이 조회가 성공했으면 앞선 **조회** 실패 문구는 더 이상 사실이 아니다. 사용자가 누른
      // 동작의 실패는 다음 동작까지 남긴다 — 폴링이 그것을 지우면 왜 실패했는지 알 수 없다.
      if(clearError||!errorFromAction.current)setError('');
    }catch(e){errorFromAction.current=false;setError(e instanceof Error?e.message:String(e));}
  },[]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(false),3000);return()=>clearInterval(timer);},[refresh]);
  const source=(value:string):AgentDialogueTarget=>value==='ops'?{target:'ops'}:{portId:value};
  const act=async(operation:'disable'|'approve'|'deny',extra:Record<string,unknown>)=>{
    setBusy(true);try{await manageAgentDialogue(operation,extra);await refresh();}catch(e){errorFromAction.current=true;setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  const setIntent=(id:string,intent:AgentDialoguePublishIntent|null)=>setInFlight(previous=>{
    const next=new Map(previous);if(intent===null)next.delete(id);else next.set(id,intent);return next;});
  /** One row's publish state. Turning a target off revokes its endpoint; turning it back on issues a
   *  new endpointId that standing invitations, rooms and pairings do not follow. */
  const publish=async(row:AgentDialoguePublishRow,on:boolean)=>{
    if(inFlight.has(row.id)||busy)return;
    if(on&&!consent){setError('먼저 아래의 Supabase 저장 동의를 체크해 주세요.');return;}
    setIntent(row.id,on?'publish':'unpublish');setError('');setConfirmOff(null);
    try{await manageAgentDialogue(on?'enable':'disable',on?{source:source(row.id),consent:true}:{source:source(row.id)});await refresh();}
    catch(e){errorFromAction.current=true;setError(`${row.name}: ${e instanceof Error?e.message:String(e)}`);}
    finally{setIntent(row.id,null);}
  };
  const publishMany=async(rows:readonly AgentDialoguePublishRow[],on:boolean)=>{
    if(busy||!rows.length)return;
    if(on&&!consent){setError('먼저 아래의 Supabase 저장 동의를 체크해 주세요.');return;}
    bulkStopRequested.current=false;setBulkStopping(false);setBulkNotice('');
    setBusy(true);setError('');setConfirmOff(null);
    const failed:string[]=[];let processed=0;
    try{
      for(const [index,row] of rows.entries()){
        if(bulkStopRequested.current)break;
        setProgress(`${on?'공개':'해제'} ${index+1}/${rows.length} · ${row.name}`);
        setIntent(row.id,on?'publish':'unpublish');
        try{await manageAgentDialogue(on?'enable':'disable',on?{source:source(row.id),consent:true}:{source:source(row.id)});}
        catch(e){failed.push(`${row.name}: ${e instanceof Error?e.message:String(e)}`);}
        finally{processed++;setIntent(row.id,null);}
      }
      await refresh();
      if(bulkStopRequested.current)setBulkNotice(`${on?'공개':'해제'} ${processed}/${rows.length}개 처리 후 중지했습니다. 나머지 대상은 변경하지 않았습니다.`);
      if(failed.length){errorFromAction.current=true;setError(`${processed-failed.length}개 완료, ${failed.length}개 실패. ${failed.slice(0,3).join(' / ')}${failed.length>3?` 외 ${failed.length-3}건`:''}`);}
    }finally{bulkStopRequested.current=false;setBulkStopping(false);setBusy(false);setProgress('');}
  };
  const enabledTargets=status?.enabled??[];
  const activePairSource=enabledTargets.find(item=>item.target===pairSource)??enabledTargets[0];
  const pairTarget=activePairSource?(activePairSource.kind==='ops'?{target:'ops' as const}:{portId:activePairSource.portId!}):null;
  const loadPairing=useCallback(async(target:{target:'ops'}|{portId:string})=>{
    try{
      const [peers,pairings]=await Promise.all([manageAgentDialogue('peers',{source:target}),manageAgentDialogue('pairings',{source:target})]);
      setPeerList(Array.isArray(peers.peers)?peers.peers:[]);
      setPairingList(Array.isArray(pairings.pairings)?pairings.pairings:[]);
    }catch(e){setPeerList([]);setPairingList([]);setError(e instanceof Error?e.message:String(e));}
  },[]);
  useEffect(()=>{if(!pairTarget)return;setPeerList(null);setPairingList(null);void loadPairing(pairTarget);},
    [loadPairing,activePairSource?.endpointId]);
  const loadCommunity=useCallback(async(target:{target:'ops'}|{portId:string})=>{
    try{setCommunityStatus(await manageAgentDialogue('community-status',{source:target}) as AgentDialogueCommunityStatus);setCommunityError('');}
    catch(e){setCommunityStatus({});setCommunityError(e instanceof Error?e.message:String(e));}
  },[]);
  useEffect(()=>{if(!pairTarget)return;setCommunityStatus(null);void loadCommunity(pairTarget);},
    [loadCommunity,activePairSource?.endpointId]);
  /** 입장 자체가 동의다 — 이 버튼이 그 승인이다. */
  const toggleCommunity=async(action:'join'|'leave')=>{
    if(!pairTarget||communityBusy)return;
    setCommunityBusy(true);setCommunityError('');
    try{await manageAgentDialogue(`community-${action}`,{source:pairTarget});await loadCommunity(pairTarget);setCommunityError('');}
    catch(e){setCommunityError(e instanceof Error?e.message:String(e));}
    finally{setCommunityBusy(false);}
  };
  /** A click here is the approval: 「아젠투지 설정」 is where every dialogue approval is given. */
  const togglePairing=async(peerEndpointId:string,connect:boolean)=>{
    if(!pairTarget||pairBusy)return;
    setPairBusy(peerEndpointId);setError('');
    try{await manageAgentDialogue(connect?'pair':'unpair',{source:pairTarget,peerEndpointId});await loadPairing(pairTarget);}
    catch(e){errorFromAction.current=true;setError(e instanceof Error?e.message:String(e));}
    finally{setPairBusy('');}
  };
  const renameDevice=async(name:string)=>{
    await onRenameDevice(name);
    try{await manageAgentDialogue('refresh-labels');await refresh();}
    catch(e){setError(`기기 이름은 저장했습니다. 대화 상대 이름은 연결이 복구되면 갱신됩니다. (${e instanceof Error?e.message:String(e)})`);}
  };
  return <div role="dialog" aria-modal="true" aria-label="에이전트 기기 간 대화" className="fixed inset-0 z-[300] flex items-center justify-center bg-black/65 p-4" onMouseDown={event=>{if(event.target===event.currentTarget&&!closeBlocked)onClose();}}>
    <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-2xl">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-bold">에이전트 기기 간 대화</h2><p className="mt-1 text-sm text-[var(--ink-2)]">기기마다 아젠투지(OPS)와 프로젝트를 대화 상대로 연결합니다. 아젠투지(OPS)는 이 기기의 OPS 운영 폴더(공유 총괄 프로필)입니다.</p>{closeBlocked&&<p role="status" className="mt-1 text-xs text-[var(--ink-2)]">{progress||'변경 적용 중…'} · 완료 후 닫을 수 있습니다.</p>}</div><button type="button" onClick={onClose} disabled={closeBlocked} className="rounded-lg border border-[var(--line)] px-3 py-2 disabled:opacity-40">닫기</button></div>
      {/* First, not below the target list: an approval nobody scrolls to looks like a broken feature (VOC 2026-10-04). */}
      <section data-testid="agent-dialogue-pending" className={`mt-4 rounded-xl border p-3 ${status?.pending.length?'border-[var(--accent)]':'border-[var(--line)]'}`}>
        <div className="flex items-center justify-between"><h3 className="font-semibold">승인 대기{status?.pending.length?` · ${status.pending.length}건`:''}</h3><button type="button" aria-label="승인 대기 새로고침" onClick={()=>void refresh()} className="text-sm underline">새로고침</button></div>
        {status?.pending.length?status.pending.map(item=><div key={item.id} data-testid="agent-dialogue-pending-item" className="mt-2 rounded-xl border border-[var(--line)] p-3 text-sm">
          <p className="break-words font-medium">{item.summary}</p>
          <p className="mt-1 text-xs text-[var(--ink-2)]">{[
            `요청한 AI ${item.client||'이름 없음'}`,item.connection?`연결 ${item.connection}`:null,
            item.requestedAt?`요청 ${timeOf(item.requestedAt)}`:null,`만료 ${timeOf(item.expiresAt)}`,
          ].filter(Boolean).join(' · ')}</p>
          <div className="mt-2 flex gap-2"><button type="button" aria-label={`${item.summary} · 요청 ${item.id.slice(0,8)} 허용`} disabled={busy} onClick={()=>void act('approve',{pendingId:item.id})} className="min-h-9 rounded-lg bg-[var(--accent)] px-3 py-1.5 font-semibold text-white">허용</button><button type="button" aria-label={`${item.summary} · 요청 ${item.id.slice(0,8)} ${item.operation==='join'?'초대 거절':'거절'}`} disabled={busy} onClick={()=>void act('deny',{pendingId:item.id})} className="min-h-9 rounded-lg border border-[var(--line)] px-3 py-1.5">{item.operation==='join'?'초대 거절':'거절'}</button></div>
        </div>):<p className="mt-2 text-sm text-[var(--ink-2)]">대기 중인 요청이 없습니다. AI가 대화를 요청하면 여기에 표시됩니다.</p>}
        {(status?.pending.length??0)>1&&<p className="mb-0 mt-2 text-xs text-[var(--ink-2)]">같은 방에 대한 요청이 여럿이면 연결 표시가 다른 별개의 AI 세션입니다. 대화를 이어갈 세션의 요청만 허용하세요.</p>}
      </section>
      {error&&<p role="alert" className="mt-4 rounded-lg border border-red-400/40 p-3 text-sm text-red-300">{error}</p>}
      {bulkNotice&&<p role="status" className="mt-4 rounded-lg border border-[var(--line)] p-3 text-sm" data-testid="agent-dialogue-bulk-notice">{bulkNotice}</p>}
      <div className="mt-4 rounded-xl border border-[var(--line)] p-3" data-testid="agent-dialogue-device-name">
        <p className="m-0 text-sm font-semibold">이 기기 별명</p>
        <DeviceNameEditor className="mt-1" value={deviceName} emptyLabel="이름 미등록" editLabel="이 기기 별명 바꾸기" placeholder="예: 아젠투지 1호" hint="예: 아젠투지 1호, 아젠투지 2호 · 같은 기기 이름 설정을 사용합니다." testIdPrefix="agent-dialogue-device-name" disabled={!deviceId} onSave={renameDevice}/>
        <p className="mb-0 mt-1 text-xs text-[var(--ink-2)]">아젠투지(OPS)와 프로젝트 대화 상대 목록에 이 이름이 표시됩니다. 이름은 식별용이며 접근 권한을 바꾸지 않습니다.</p>
      </div>
      <p className="mt-4 rounded-xl border border-[var(--line)] p-3 text-sm leading-relaxed">참여한 에이전트의 짧은 메시지와 대상 정보는 연결된 Supabase에 저장됩니다. 대화방은 기본 24시간, 유휴 2시간 후 만료됩니다. 종료·만료 후 7일이 지나면 연결된 앱의 다음 유지보수에서 본문을 삭제합니다. 받은 메시지는 지시나 기억 저장으로 자동 실행되지 않습니다.</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold" data-testid="agent-dialogue-publish-count">이 기기에서 공개 중 · {publishSummary.published}/{publishSummary.total}개{publishSummary.missing?` · 앱 목록에 없는 ${publishSummary.missing}개 포함`:''}</span><div className="flex gap-2"><button type="button" disabled={busy||!consent} data-testid="agent-dialogue-publish-all" onClick={()=>void publishMany(allPublishRows.filter(row=>!agentDialogueRowChecked(row)),true)} className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm">전체 공개</button><button type="button" disabled={busy} data-testid="agent-dialogue-unpublish-all" onClick={()=>setConfirmOff('*')} className="rounded-lg border border-[var(--line)] px-3 py-2 text-sm">전체 해제</button></div></div>
      <input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="대상 이름으로 찾기" aria-label="공개 대상 찾기" data-testid="agent-dialogue-publish-search" className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm"/>
      {confirmOff==='*'&&<div role="alertdialog" aria-label="전체 해제 확인" className="mt-2 rounded-xl border border-[var(--accent)] p-3 text-sm" data-testid="agent-dialogue-unpublish-all-confirm"><p className="m-0">공개를 모두 끄면 각 대상의 endpoint가 폐기됩니다. 다시 켜면 <strong>새 endpointId</strong>가 발급되고, 지금 걸려 있는 초대·대화방·30일 연결은 따라오지 않습니다.</p><div className="mt-2 flex gap-2"><button type="button" className="rounded-lg border border-[var(--line)] px-3 py-1" onClick={()=>void publishMany(allPublishRows.filter(agentDialogueRowChecked),false)}>모두 끄기</button><button type="button" className="rounded-lg border border-[var(--line)] px-3 py-1" onClick={()=>setConfirmOff(null)}>취소</button></div></div>}
      <div role="group" aria-label="이 기기에서 공개 중인 대상" className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-[var(--line)] p-2" data-testid="agent-dialogue-publish-list">
        {publishRows.slice(0,publishLimit).map(row=><div key={row.id} data-testid="agent-dialogue-publish-row" data-published={agentDialogueRowChecked(row)?'true':'false'}>
          <label className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm"><input type="checkbox" checked={agentDialogueRowChecked(row)} disabled={busy||inFlight.has(row.id)} onChange={event=>{if(event.target.checked)void publish(row,true);else setConfirmOff(row.id);}}/><span className="flex-1">{row.name}</span>{row.missing&&<span className="rounded bg-[var(--line)] px-1.5 py-0.5 text-xs">앱 목록에 없음</span>}{row.endpointId&&<span className="text-xs text-[var(--ink-2)]">{row.endpointId.slice(0,8)}</span>}{inFlight.has(row.id)&&<span role="status" className="text-xs text-[var(--ink-2)]">적용 중…</span>}</label>
          {confirmOff===row.id&&<div role="alertdialog" aria-label={`${row.name} 연결 끄기 확인`} className="mx-2 mb-2 rounded-xl border border-[var(--accent)] p-3 text-sm" data-testid="agent-dialogue-unpublish-confirm"><p className="m-0">이 대상의 endpoint가 폐기됩니다. 다시 켜면 <strong>새 endpointId</strong>가 발급되고, 지금 걸려 있는 초대·대화방·30일 연결은 따라오지 않습니다.</p><div className="mt-2 flex gap-2"><button type="button" aria-label={`${row.name} 연결 끄기`} className="rounded-lg border border-[var(--line)] px-3 py-1" onClick={()=>void publish(row,false)}>연결 끄기</button><button type="button" className="rounded-lg border border-[var(--line)] px-3 py-1" onClick={()=>setConfirmOff(null)}>취소</button></div></div>}
        </div>)}
        {status===null?<p className="m-2 text-sm text-[var(--ink-2)]">공개 상태 확인 중…</p>:publishRows.length===0&&<p className="m-2 text-sm text-[var(--ink-2)]">{search?'찾는 이름과 일치하는 대상이 없습니다.':'공개할 수 있는 대상이 없습니다.'}</p>}
        <IncrementalListMore shown={Math.min(publishLimit,publishRows.length)} total={publishRows.length} onMore={showMorePublish} testId="agent-dialogue-publish-more"/>
      </div>
      <p className="mt-2 text-xs text-[var(--ink-2)]">체크는 이 기기가 상대 목록에 공개하는 상태 그대로입니다. 해제하면 그 대상의 연결을 끕니다. 다른 기기의 워크룸 직접 제어는 그 기기의 원격 작업 승인 범위에서 따로 확인합니다.</p>
      <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/><span>이 대상의 기기 간 대화 정보가 Supabase에 저장되는 데 동의합니다.</span></label>
      {progress&&<div className="mt-2 flex flex-wrap items-center gap-2"><p role="status" className="m-0 text-xs text-[var(--ink-2)]" data-testid="agent-dialogue-publish-progress">{progress}</p><button type="button" data-testid="agent-dialogue-publish-stop" disabled={bulkStopping} className="rounded-lg border border-[var(--line)] px-3 py-1 text-xs disabled:opacity-40" onClick={()=>{bulkStopRequested.current=true;setBulkStopping(true);}}>{bulkStopping?'중지 요청됨 · 현재 항목 완료 대기':'현재 항목 뒤 중지'}</button></div>}
      <section className="mt-5 rounded-xl border border-[var(--accent)] p-3" data-testid="agent-dialogue-community">
        <h3 className="m-0 font-semibold">커뮤니티 · 이 운영 프로필의 단체방</h3>
        <p className="mb-0 mt-1 text-xs text-[var(--ink-2)]">부르는 것이 아니라 <strong>각자 한 번 입장</strong>합니다. 들어와 있는 대상끼리는 초대도 승인도 없이 주고받고, 나가지 않는 한 계속 참여합니다.</p>
        {enabledTargets.length===0?<p className="mt-2 text-sm text-[var(--ink-2)]">위에서 공개할 대상을 먼저 켜세요.</p>:(()=>{
          const view=agentDialogueCommunityView(communityStatus,activePairSource?.endpointId);
          return <>
            <p className="mt-3 mb-0 text-sm font-semibold" data-testid="agent-dialogue-community-headline">{view.headline}</p>
            <p className="mb-0 mt-1 text-xs text-[var(--ink-2)]">{view.detail}</p>
            {view.waiting&&<p className="mb-0 mt-2 rounded-lg border border-[var(--accent)] px-2 py-1.5 text-xs font-semibold" role="status" data-testid="agent-dialogue-community-unread">{view.waiting}</p>}
            <button type="button" data-testid="agent-dialogue-community-action" data-state={view.state}
              disabled={view.action===null||communityBusy||busy}
              onClick={()=>{if(view.action)void toggleCommunity(view.action);}}
              className={`mt-3 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-45 ${view.action==='leave'?'border border-[var(--line)]':'bg-[var(--accent)] text-white'}`}
            >{communityBusy?'적용 중…':view.actionLabel}</button>
            {communityError&&<p role="alert" className="mt-2 mb-0 text-xs text-red-300" data-testid="agent-dialogue-community-error">{communityError}</p>}
            {view.members.length>0&&<div className="mt-3 rounded-xl border border-[var(--line)] p-2" data-testid="agent-dialogue-community-members">
              {view.members.map(member=><div key={member.endpointId} className="flex min-h-8 items-center justify-between gap-2 px-2 text-sm">
                <span>{agentDialogueCommunityMemberLabel(member,activePairSource?.endpointId)}</span>
                <span className="text-xs text-[var(--ink-2)]">{member.kind==='ops'?'총괄':'프로젝트'}{member.joinedAt?` · ${new Date(member.joinedAt).toLocaleDateString()} 입장`:''}</span>
              </div>)}
            </div>}
          </>;
        })()}
      </section>
      <section className="mt-5 rounded-xl border border-[var(--line)] p-3" data-testid="agent-dialogue-pairings">
        <h3 className="m-0 font-semibold">1:1 연결 · 30일{pairRows.length?` · 활성 ${pairSummary.active}개${pairSummary.waiting?` · 수락 대기 ${pairSummary.waiting}개`:''}`:''}</h3>
        <p className="mb-0 mt-1 text-xs text-[var(--ink-2)]">보통은 위의 커뮤니티로 충분합니다. 여기는 <strong>특정 상대와만</strong> 따로 쓸 때입니다 — 양쪽이 각자 한 번 연결하면 30일 동안 방마다 승인하지 않고, 상대가 연 방에는 이 기기가 스스로 들어갑니다.</p>
        {enabledTargets.length===0?<p className="mt-2 text-sm text-[var(--ink-2)]">위에서 공개할 대상을 먼저 켜세요.</p>:<>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-sm">내 대상<select aria-label="연결에 쓸 내 대상" className="rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-sm" value={activePairSource?.target??''} onChange={event=>setPairSource(event.target.value)}>{enabledTargets.map(item=><option key={item.endpointId} value={item.target}>{item.displayName}</option>)}</select></label>
            <input type="search" value={pairSearch} onChange={event=>setPairSearch(event.target.value)} placeholder="상대 기기·대상 찾기" aria-label="연결할 상대 찾기" data-testid="agent-dialogue-pair-search" className="min-w-40 flex-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-1.5 text-sm"/>
            <button type="button" aria-label="1:1 연결 새로고침" className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-sm" disabled={!!pairBusy} onClick={()=>{if(pairTarget)void loadPairing(pairTarget);}}>새로고침</button>
          </div>
          <div role="group" aria-label="연결할 상대" className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-[var(--line)] p-2" data-testid="agent-dialogue-pair-list">
            {peerList===null?<p className="m-2 text-sm text-[var(--ink-2)]">상대 목록 확인 중…</p>
              :pairRows.length===0?<p className="m-2 text-sm text-[var(--ink-2)]">{pairSearch?'찾는 이름과 일치하는 상대가 없습니다.':'연결된 다른 기기의 대상이 아직 없습니다.'}</p>
              :pairRows.slice(0,pairLimit).map(row=><div key={row.endpointId} className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm" data-testid="agent-dialogue-pair-row" data-state={row.state}>
                <span className="flex-1">{row.displayName}<span className="ml-2 text-xs text-[var(--ink-2)]">{row.state==='active'?`연결됨${row.expiresAt?` · ${new Date(row.expiresAt).toLocaleDateString()}까지`:''}`:row.state==='waiting-peer'?'상대 수락 대기':row.state==='waiting-me'?'상대가 요청함 · 수락하면 연결':row.state==='expired'?'기간 만료 · 다시 연결하세요':'연결 없음'}</span></span>
                {row.state==='active'
                  ?<button type="button" aria-label={`${row.displayName} · 연결 ${row.endpointId.slice(0,8)} 해지`} className="rounded-lg border border-[var(--line)] px-3 py-1" disabled={pairBusy===row.endpointId} onClick={()=>void togglePairing(row.endpointId,false)}>연결 해지</button>
                  :<button type="button" aria-label={`${row.displayName} · 연결 ${row.endpointId.slice(0,8)} ${row.state==='waiting-me'?'수락하기':row.state==='waiting-peer'?'다시 요청':'30일 연결'}`} className="rounded-lg border border-[var(--line)] px-3 py-1" disabled={pairBusy===row.endpointId} onClick={()=>void togglePairing(row.endpointId,true)}>{row.state==='waiting-me'?'수락하기':row.state==='waiting-peer'?'다시 요청':'30일 연결'}</button>}
              </div>)}
            <IncrementalListMore shown={Math.min(pairLimit,pairRows.length)} total={pairRows.length} onMore={showMorePairs} testId="agent-dialogue-pair-more"/>
          </div>
        </>}
      </section>
      {!!status?.remoteRevocationPending&&<p role="status" className="mt-3 text-sm text-amber-300">이 기기의 연결은 꺼졌습니다. 서버 해제 {status.remoteRevocationPending}건은 연결이 복구되면 재시도합니다.</p>}
    </div>
  </div>;
}
