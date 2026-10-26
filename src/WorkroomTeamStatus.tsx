import React,{useEffect,useRef,useState} from 'react';
import {ChevronDown,ChevronUp,RefreshCw,Users,X} from 'lucide-react';
import {requestWorkroomTeamPanel,requestWorkroomTeamPanelAction,requestWorkroomTeamMemberBrief} from './aiTerminalClient';
import type {TeamPanelAction} from './workroomTeamPanelActions';
import {teamMemberAwaiting,teamMemberDisplay,type TeamMemberDisplay,type TeamPanelMember,type TeamPanelTeam} from './workroomTeamPanel';
import {workroomTeamSurfaceCopy} from './workroomTeamSurfaceCopy';
import {TEAM_AGENT_LABEL,teamEffortSupported} from './workroomTeamInstruction';
import {TEAM_SURFACE_NAME,type TeamLaunchSurface} from './teamLaunchOptions';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {workroomTeamCopy,workroomTeamStatusCopy} from './i18n';
import {useAppLanguage} from './useAppLanguage';
import './WorkroomTeamStatus.css';

/** An active team is looked at every 5 s; otherwise every 15 s, so a team the leader creates meanwhile still shows up. */
const ACTIVE_POLL_MS=5_000,IDLE_POLL_MS=15_000;
const fill=(text:string,values:Record<string,string|number>)=>text.replace(/\{(\w+)\}/g,(token,name)=>Object.hasOwn(values,name)?String(values[name]):token);
/** Member states and reports in one string: when it changes, the next read brings the Git summary along. */
/** 「복사했습니다」 is only ever shown for the member whose brief actually reached the clipboard. */
const copy_brief_label=(copied:string,team:TeamPanelTeam,member:TeamPanelMember,copy:{copyBrief:string;copyBriefDone:string;copyBriefFailedShort:string})=>{
  const key=team.id+'/'+member.id;
  return copied===key?copy.copyBriefDone:copied===key+':failed'?copy.copyBriefFailedShort:copy.copyBrief;
};
const APP_PRODUCT={codex:'Codex',claude:'Claude',hermes:'Hermes',agy:'Antigravity'} as const;
type ActionError={operation:TeamPanelAction['operation'];message:string};
const selectBrief=(node:HTMLTextAreaElement|null)=>{if(node){node.focus();node.select();node.setSelectionRange(0,node.value.length);}};
const shapeOf=(teams:TeamPanelTeam[])=>teams.map(team=>team.id+':'+team.state+':'+team.members.map(member=>member.id+'='+teamMemberDisplay(member)+'@'+(member.report?.at??'')).join(',')).join('|');

/**
 * 팀 현황 (src/workroomTeamPanel.ts): above the terminal of a session that leads or belongs to a 팀 작전, one row a member —
 * AI, model, effort, state, last output, report, commits and 「열기」. It only reads; the leader still merges and closes.
 * Nothing shows for a session in no team. Reads stop while the Workroom is off screen or the window is hidden.
 */
export function WorkroomTeamStatus({sessionId,visible,openable,onOpen,onConfirm,onManualReport}:{sessionId:string;visible:boolean;openable:(sessionId:string)=>boolean;onOpen:(sessionId:string)=>void;
  /** Wired by the host screen: the leader's manual confirmation and transcribed report for a surface it cannot read. */
  onConfirm?:(team:TeamPanelTeam,member:TeamPanelMember,confirm:'started'|'delivered')=>void;onManualReport?:(team:TeamPanelTeam,member:TeamPanelMember)=>void}){
  const [lang]=useAppLanguage(),copy=workroomTeamStatusCopy(lang),teamCopy=workroomTeamCopy(lang),surfaceCopy=workroomTeamSurfaceCopy(lang);
  const [copied,setCopied]=useState('');
  const [briefFallback,setBriefFallback]=useState<{key:string;text:string}|null>(null);
  const briefNode=useRef<HTMLTextAreaElement>(null);
  const briefSelectionFrame=useRef<number|null>(null);
  const [actionBusy,setActionBusy]=useState(false),[reportDraft,setReportDraft]=useState<{teamId:string;memberId:string;status:'done'|'blocked';summary:string}|null>(null);
  const actionEpoch=useRef(0),actionPending=useRef(false);
  const [teams,setTeams]=useState<TeamPanelTeam[]>([]);
  const [loadError,setLoadError]=useState(''),[actionErrors,setActionErrors]=useState<Record<string,ActionError>>({});
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({});
  const [hidden,setHidden]=useState<string[]>([]);
  const [now,setNow]=useState(()=>Date.now());
  const refresh=useRef<()=>void>(()=>{});
  const clearActionError=(key:string)=>setActionErrors(current=>{if(!current[key])return current;const next={...current};delete next[key];return next;});
  const cancelBriefSelection=()=>{if(briefSelectionFrame.current!==null){cancelAnimationFrame(briefSelectionFrame.current);briefSelectionFrame.current=null;}};
  const scheduleBriefSelection=(node:HTMLTextAreaElement)=>{
    cancelBriefSelection();const epoch=actionEpoch.current;
    // WebKit finishes keyboard focus by resetting the caret. Select after that, without reclaiming a later focus.
    briefSelectionFrame.current=requestAnimationFrame(()=>{
      briefSelectionFrame.current=null;
      if(epoch===actionEpoch.current&&briefNode.current===node&&node.isConnected&&node.ownerDocument.activeElement===node){node.select();node.setSelectionRange(0,node.value.length);}
    });
  };
  useEffect(()=>{
    if(!briefFallback)return;
    const frame=requestAnimationFrame(()=>selectBrief(briefNode.current));
    return()=>{cancelAnimationFrame(frame);cancelBriefSelection();};
  },[briefFallback]);
  useEffect(()=>{
    actionEpoch.current++;actionPending.current=false;setActionBusy(false);setReportDraft(null);setBriefFallback(null);setCopied('');
    setTeams([]);setLoadError('');setActionErrors({});setHidden([]);
    if(!visible)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>|null=null,ticket=0,shape='',active=false;
    const git=new Map<string,TeamPanelMember['git']>();
    const read=async(withGit:boolean):Promise<void>=>{
      const mine=++ticket;
      try{
        const result=await requestWorkroomTeamPanel({sessionId,git:withGit});
        if(stopped||mine!==ticket)return;
        // Between Git reads each member keeps the summary it last had.
        const teams=result.teams.map(team=>({...team,members:team.members.map(member=>{const key=team.id+'/'+member.id;if(withGit)git.set(key,member.git);return withGit?member:{...member,git:git.get(key)??null};})}));
        const next=shapeOf(teams),changed=next!==shape;shape=next;active=teams.some(team=>team.state==='active');
        setTeams(teams);setLoadError('');setNow(Date.now());
        // At most the current panel's three teams × six members. Polling preserves each existing row's action error.
        const keys=new Set(teams.flatMap(team=>team.members.map(member=>team.id+'/'+member.id)));
        setActionErrors(current=>Object.fromEntries(Object.entries(current).filter(([key])=>keys.has(key))));
        if(changed&&!withGit)await read(true);
      }catch(cause){if(!stopped&&mine===ticket)setLoadError(cause instanceof Error?cause.message:String(cause));}
    };
    // One timer at a time: a refresh landing beside a scheduled read replaces it instead of starting a second chain.
    const schedule=()=>{if(timer)clearTimeout(timer);timer=stopped?null:setTimeout(tick,active?ACTIVE_POLL_MS:IDLE_POLL_MS);};
    const tick=()=>{timer=null;if(typeof document!=='undefined'&&document.visibilityState==='hidden'){schedule();return;}void read(false).then(schedule);};
    refresh.current=()=>{void read(true).then(schedule);};
    void read(true).then(schedule);
    return()=>{stopped=true;actionEpoch.current++;if(timer)clearTimeout(timer);refresh.current=()=>{};};
  },[sessionId,visible]);

  const record=async(action:TeamPanelAction)=>{
    if(actionPending.current)return;const epoch=actionEpoch.current;
    const key=action.teamId+'/'+action.memberId;
    actionPending.current=true;setActionBusy(true);clearActionError(key);
    try{await requestWorkroomTeamPanelAction(action);if(epoch===actionEpoch.current){setReportDraft(null);refresh.current();}}
    catch(cause){if(epoch===actionEpoch.current)setActionErrors(current=>({...current,[key]:{operation:action.operation,message:cause instanceof Error?cause.message:String(cause)}}));}
    finally{if(epoch===actionEpoch.current){actionPending.current=false;setActionBusy(false);}}
  };
  const confirm=(team:TeamPanelTeam,member:TeamPanelMember,value:'started'|'delivered')=>{
    if(onConfirm)onConfirm(team,member,value);else void record({sessionId,operation:'confirm-member',teamId:team.id,memberId:member.id,confirm:value});
  };
  const editReport=(team:TeamPanelTeam,member:TeamPanelMember)=>{
    clearActionError(team.id+'/'+member.id);
    if(onManualReport)onManualReport(team,member);else setReportDraft({teamId:team.id,memberId:member.id,status:member.report?.status??'done',summary:member.report?.summary??''});
  };

  const shown=teams.filter(team=>!hidden.includes(team.id));
  if(!shown.length&&!loadError)return null;
  const relative=(at:number)=>{
    const seconds=Math.round((at-now)/1000),abs=Math.abs(seconds),format=new Intl.RelativeTimeFormat(lang,{numeric:'auto'});
    return abs<60?format.format(seconds,'second'):abs<3600?format.format(Math.round(seconds/60),'minute'):abs<86400?format.format(Math.round(seconds/3600),'hour'):format.format(Math.round(seconds/86400),'day');
  };
  const stateLabel:Record<TeamMemberDisplay,string>={starting:copy.stateStarting,working:copy.stateWorking,reported:copy.stateReported,blocked:copy.stateBlocked,failed:copy.stateFailed,unknown:copy.stateUnknown,closed:copy.stateClosed,ended:copy.stateEnded,
    'awaiting-connection':surfaceCopy.stateAwaitingConnection,'awaiting-manual-join':surfaceCopy.stateAwaitingManualJoin,'awaiting-ack':surfaceCopy.stateAwaitingAck};
  const deliveryLabel=(member:TeamPanelMember)=>member.delivery==='verified'?surfaceCopy.deliveryVerified:member.delivery==='manual'?surfaceCopy.deliveryManual
    :member.delivery==='unknown'?surfaceCopy.deliveryUnknown:member.delivery==='not-sent'?surfaceCopy.deliveryNotSent:'';
  // Explicit local copy includes the exact member checkout and shared team rules; no credentials or launch environment.
  const copyBrief=async(team:TeamPanelTeam,member:TeamPanelMember)=>{
    const key=team.id+'/'+member.id;
    const epoch=actionEpoch.current;
    clearActionError(key);setCopied('');setBriefFallback(null);
    let brief:string|undefined;
    try{brief=await requestWorkroomTeamMemberBrief({sessionId,teamId:team.id,memberId:member.id});if(epoch!==actionEpoch.current)return;await navigator.clipboard.writeText(brief);if(epoch===actionEpoch.current){setCopied(key);setBriefFallback(null);}}
    catch(cause){if(epoch===actionEpoch.current){if(brief!==undefined){setBriefFallback({key,text:brief});setCopied(key+':failed');}else setActionErrors(current=>({...current,[key]:{operation:'copy-brief',message:cause instanceof Error?cause.message:String(cause)}}));}}
  };
  const surfaceLabel=(surface:TeamLaunchSurface,member:TeamPanelMember)=>surface==='internal'?teamCopy.surfaceWorkroom:surface==='orca-floating'?`Orca · ${teamCopy.surfaceFloating}`
    :surface==='orca-worktree'?`Orca · ${teamCopy.surfaceSidebar}`:surface==='app'?fill(teamCopy.surfaceApp,{app:APP_PRODUCT[member.agent]}):TEAM_SURFACE_NAME[surface];
  const launchLabel=(member:TeamPanelMember)=>{
    const options=member.launchOptions??{},off=(option:string)=>fill(surfaceCopy.optionOff,{option});
    return [surfaceLabel(member.surface!,member),...(options.bgMode!==undefined?[options.bgMode?'Claude --bg':off('Claude --bg')]:[]),
      ...(options.tmuxMode!==undefined?[options.tmuxMode?'tmux':off('tmux')]:[]),...(options.reuse?[options.reuse==='new'?surfaceCopy.newWindow:teamCopy.reuse]:[]),
      ...(options.appMode?[options.appMode==='new'?teamCopy.appModeNew:options.appMode==='reopen'?teamCopy.appModeReopen:teamCopy.appModeOpen]:[])].join(' · ');
  };
  const effortLabel:Record<WorkroomEffortLevel,string>={low:teamCopy.effortLow,medium:teamCopy.effortMedium,high:teamCopy.effortHigh};
  // A member that joined from an open session keeps whatever it runs with; the strip does not guess its model.
  const modelLine=(member:TeamPanelMember)=>member.attached?`${TEAM_AGENT_LABEL[member.agent]} · ${copy.attachedModel}`:[TEAM_AGENT_LABEL[member.agent],member.model?(member.provider?`${member.provider}/${member.model}`:member.model):teamCopy.modelPlaceholder,
    ...(teamEffortSupported(member.agent)?[member.effort?`${teamCopy.effort} ${effortLabel[member.effort]}`:teamCopy.effortAuto]:[])].join(' · ');
  return <div className="workroom-team-status" data-testid="workroom-team-status">
   {shown.map(team=>{
    const folded=collapsed[team.id]??team.state==='closed',own=team.members.find(member=>member.id===team.memberId);
    return <section key={team.id} className="workroom-team-status__team" aria-label={`${copy.heading} · ${team.title}`} data-team-state={team.state}>
     <header className="workroom-team-status__head">
      <Users size={13} aria-hidden="true"/>
      <strong title={`${copy.goal}: ${team.goal}`}>{team.title}</strong>
      <span className="workroom-team-status__role">{own?fill(copy.roleMember,{member:own.name}):copy.roleLeader}</span>
      <span className="workroom-team-status__count" data-testid="workroom-team-status-count">{team.state==='closed'?copy.teamClosed:fill(copy.settled,{settled:team.settled,total:team.members.length})}</span>
      {own&&team.leader.sessionId&&team.leader.sessionId!==sessionId&&<button type="button" className="workroom-team-status__btn" data-testid="workroom-team-status-open-leader"
        disabled={!openable(team.leader.sessionId)} title={openable(team.leader.sessionId)?undefined:copy.notListed} onClick={()=>onOpen(team.leader.sessionId!)}>{copy.openLeader}</button>}
      <button type="button" className="workroom-team-status__icon" aria-label={copy.refresh} title={copy.refresh} data-testid="workroom-team-status-refresh" onClick={()=>refresh.current()}><RefreshCw size={12}/></button>
      <button type="button" className="workroom-team-status__icon" aria-expanded={!folded} aria-label={folded?copy.expand:copy.collapse} title={folded?copy.expand:copy.collapse}
        onClick={()=>setCollapsed(current=>({...current,[team.id]:!folded}))}>{folded?<ChevronDown size={13}/>:<ChevronUp size={13}/>}</button>
      {team.state==='closed'&&<button type="button" className="workroom-team-status__icon" aria-label={copy.dismiss} title={copy.dismiss} onClick={()=>setHidden(ids=>[...ids,team.id])}><X size={12}/></button>}
     </header>
     {!folded&&<ul className="workroom-team-status__members">
      {team.members.map(member=>{
       const display=teamMemberDisplay(member),mine=member.id===team.memberId,canOpen=!!member.sessionId&&openable(member.sessionId),key=team.id+'/'+member.id;
       const confirmable=member.state==='starting'||member.state==='working'||teamMemberAwaiting(member),actionError=actionErrors[key];
       return <li key={member.id} className="workroom-team-status__member" data-testid="workroom-team-status-member" data-state={display} data-member-id={member.id}>
        <div className="workroom-team-status__line">
         <span className={`workroom-team-status__chip workroom-team-status__chip--${display}`}>{stateLabel[display]}</span>
         <b className="workroom-team-status__name">{member.name}{member.role==='reviewer'&&<small className="workroom-team-status__tag">{copy.reviewer}</small>}{member.attached&&<small className="workroom-team-status__tag workroom-team-status__tag--attached">{copy.attached}</small>}{mine&&<small>{copy.you}</small>}</b>
         <span className="workroom-team-status__model">{modelLine(member)}<span className="workroom-team-status__activity"> · {member.lastOutputAt?fill(copy.lastOutput,{time:relative(member.lastOutputAt)}):copy.noOutput}</span></span>
         {!mine&&member.sessionId&&<button type="button" className="workroom-team-status__btn" data-testid="workroom-team-status-open" disabled={!canOpen}
           title={canOpen?copy.openTitle:copy.notListed} onClick={()=>onOpen(member.sessionId!)}>{copy.open}</button>}
        </div>
        {/* Every member is visible with the surface the user picked — a Workroom member keeps its existing single line. */}
        {member.surface&&<p className="workroom-team-status__surface" data-testid="workroom-team-status-surface" data-surface={member.surface}>
         <span className="workroom-team-status__tag">{surfaceCopy.surfaceLabel} {launchLabel(member)}</span>
         {member.effectiveSurface&&member.effectiveSurface!==member.surface&&<small>{fill(surfaceCopy.surfaceFallback,{surface:surfaceLabel(member.effectiveSurface,member)})}</small>}
         {member.delivery&&<small data-delivery={member.delivery}>{deliveryLabel(member)}</small>}
         {member.owned===false&&<small>{surfaceCopy.notOwned}</small>}
         {member.manual&&<small>{fill(member.manual.confirmed==='started'?surfaceCopy.manualStarted:surfaceCopy.manualDelivered,{time:relative(Date.parse(member.manual.at))})}</small>}
        </p>}
        {briefFallback?.key===key&&<div className="workroom-team-status__brief-copy">
         <p className="workroom-team-status__note" role="status">{surfaceCopy.copyBriefFailed}</p>
         <textarea ref={briefNode} className="workroom-team-status__brief" data-testid="workroom-team-status-brief-fallback" aria-label={surfaceCopy.briefText} readOnly value={briefFallback.text}
          onFocus={event=>scheduleBriefSelection(event.currentTarget)} onBlur={cancelBriefSelection} onMouseUp={event=>{event.preventDefault();selectBrief(event.currentTarget);}}/>
         <button type="button" className="workroom-team-status__btn" data-testid="workroom-team-status-select-brief" onClick={()=>selectBrief(briefNode.current)}>{surfaceCopy.selectBrief}</button>
        </div>}
        <p className="workroom-team-status__task" title={member.task}>{member.task}</p>
        {/* A surface the host cannot drive gets real actions instead of a pretend 「working」: copy the brief, say what you saw. */}
        {member.surface&&member.surface!=='internal'&&team.state==='active'&&team.role==='leader'&&!mine&&<p className="workroom-team-status__manual" data-testid="workroom-team-status-manual">
         <button type="button" className="workroom-team-status__btn" data-testid="workroom-team-status-copy-brief" onClick={()=>void copyBrief(team,member)}>{copy_brief_label(copied,team,member,surfaceCopy)}</button>
         {confirmable&&teamMemberAwaiting(member)&&<button type="button" disabled={actionBusy} className="workroom-team-status__btn" data-testid="workroom-team-status-confirm-started"
           title={surfaceCopy.confirmStartedTitle} onClick={()=>confirm(team,member,'started')}>{surfaceCopy.confirmStarted}</button>}
         {confirmable&&member.delivery!=='verified'&&<button type="button" disabled={actionBusy} className="workroom-team-status__btn" data-testid="workroom-team-status-confirm-delivered"
           title={surfaceCopy.confirmDeliveredTitle} onClick={()=>confirm(team,member,'delivered')}>{surfaceCopy.confirmDelivered}</button>}
         {<button type="button" disabled={actionBusy} className="workroom-team-status__btn" data-testid="workroom-team-status-manual-report"
           title={surfaceCopy.manualReportTitle} onClick={()=>editReport(team,member)}>{surfaceCopy.manualReport}</button>}
        </p>}
        {reportDraft?.teamId===team.id&&reportDraft.memberId===member.id&&team.role==='leader'&&team.state==='active'&&<form className="workroom-team-status__report-form" data-testid="workroom-team-status-report-form" onSubmit={event=>{event.preventDefault();void record({sessionId,operation:'report-member',...reportDraft});}}>
         <label>{surfaceCopy.reportSummary}<textarea required disabled={actionBusy} value={reportDraft.summary} onChange={event=>{clearActionError(key);setReportDraft({...reportDraft,summary:event.target.value});}}/></label>
         <select aria-label={copy.reportLabel} disabled={actionBusy} value={reportDraft.status} onChange={event=>{clearActionError(key);setReportDraft({...reportDraft,status:event.target.value as 'done'|'blocked'});}}><option value="done">{copy.stateReported}</option><option value="blocked">{copy.stateBlocked}</option></select>
         <button className="workroom-team-status__btn" type="submit" disabled={actionBusy||!reportDraft.summary.trim()||new TextEncoder().encode(reportDraft.summary.trim()).length>8000}>{surfaceCopy.saveReport}</button>
         <button className="workroom-team-status__btn" type="button" disabled={actionBusy} onClick={()=>{clearActionError(key);setReportDraft(null);}}>{surfaceCopy.cancelReport}</button>
        </form>}
        {actionError&&<p className="workroom-team-status__error" role="alert" data-testid="workroom-team-status-action-error">{fill(actionError.operation==='report-member'?surfaceCopy.reportError:actionError.operation==='confirm-member'?surfaceCopy.confirmError:surfaceCopy.briefError,{error:actionError.message})}</p>}
        {member.note&&<p className="workroom-team-status__note" data-testid="workroom-team-status-note">{member.note}</p>}
        {member.report&&<p className="workroom-team-status__report" data-status={member.report.status} data-provenance={member.report.provenance} title={member.report.summary}>
         <b>{member.report.status==='done'?copy.reportLabel:copy.blockedLabel}</b>
         {member.report.provenance==='manual'&&<small className="workroom-team-status__tag" data-testid="workroom-team-status-report-manual">{surfaceCopy.reportManual}</small>} {member.report.summary}</p>}
        {member.error&&<p className="workroom-team-status__error" role="status">{member.error}</p>}
        {member.git&&<p className="workroom-team-status__git" data-testid="workroom-team-status-git">{member.git.commits?`${fill(copy.git,{commits:member.git.commits,files:member.git.files,insertions:member.git.insertions,deletions:member.git.deletions})} · ${member.git.merged?copy.merged:copy.notMerged}`:copy.noCommits}</p>}
       </li>;
      })}
     </ul>}
    </section>;
   })}
   {loadError&&<p className="workroom-team-status__error" role="status" data-testid="workroom-team-status-load-error">{fill(copy.loadError,{error:loadError})}</p>}
  </div>;
}
