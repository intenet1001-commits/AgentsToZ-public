import React,{useMemo,useRef,useState} from 'react';
import {Plus,Users,X} from 'lucide-react';
import {AI_TERMINAL_AGENTS,type AiTerminalAgent} from './aiTerminalProtocol';
import {HOST_CLI_ACCOUNT_ID,type CliAccountAgent} from './cliAccountProtocol';
import {isWindowsClient} from './clientPlatform';
import {HERMES_VARIANT_NAME,HERMES_VARIANT_PROVIDER,hermesVariantModel,hermesVariantOf,launchChoiceId,launchChoiceTarget,workroomLaunchChoices,type HermesVariant,type HermesVariantItem} from './hermesVariants';
import {useHermesVariants} from './hermesVariantsClient';
import type {TeamAccountChoices} from './teamAccountChoices';
import {normalizeTeamLaunchOptions,teamLaunchDefaults,teamLaunchManagement,teamLaunchReuseAvailable,teamLaunchSupport,teamLaunchSurfacesFor,TEAM_SURFACE_NAME,type TeamAppMode,type TeamLaunchManagement,type TeamLaunchManagementReason,type TeamLaunchOptions,type TeamLaunchSurface} from './teamLaunchOptions';
import {LAUNCH_MODEL_NAME,TEAM_AGENT_LABEL,TEAM_MAX_MEMBERS,TEAM_MODEL_CHOICES,readTeamBuilderDraft,teamLeaderInstruction,type TeamLeaderMember,type TeamMemberRole} from './workroomTeamInstruction';
import type {WorkroomEffortLevel} from './workroomEffortPolicy';
import {teamEffortIsRequest,teamEffortLevels} from './teamEffortCatalog';
import {hermesVariantCopy,workroomTeamCopy,type Lang} from './i18n';
import {useAppLanguage} from './useAppLanguage';
import './WorkroomTeamBuilder.css';

/**
 * `custom`: the person types the model (and Hermes provider) instead of picking one of TEAM_MODEL_CHOICES. `effort` '' is 자동.
 * `sessionId`: an open session joins as this member (src/workroomTeam.ts attach) — it keeps its own model and effort.
 * `variant`: 「Hermes · Claude/Codex」 (src/hermesVariants.ts) — Hermes on that provider, so only that provider's models.
 * `surface`…`options`: where project open would run it and with what (src/teamLaunchOptions.ts). `accountId` '' names no
 * account: the member's new worktree has no account of its own, so its CLI starts on this Mac's default login (host-default) —
 * never «the account this Workroom selects». Bypass is off until the person turns it on for this member.
 * `computerUse`: a desktop app member's opt-in (computerUseApprovals) — off until the person ticks it for that member.
 */
export interface TeamBuilderRow {key:number;name?:string;agent:AiTerminalAgent;variant:HermesVariant|'';model:string;provider:string;custom:boolean;effort:WorkroomEffortLevel|'';role:TeamMemberRole;task:string;sessionId:string;
  surface:TeamLaunchSurface;accountId:string;bypass:boolean;options:TeamLaunchOptions;computerUse?:boolean}
type MemberRow=TeamBuilderRow;
export const blankTeamRow=(key:number,agent:AiTerminalAgent,role:TeamMemberRole='worker'):MemberRow=>({key,agent,variant:'',model:'',provider:'',custom:false,effort:'',role,task:'',sessionId:'',surface:'internal',accountId:'',bypass:false,options:{}});
const blankRow=blankTeamRow;
export function restoredTeamRows(members:readonly TeamLeaderMember[]):TeamBuilderRow[]{
  return members.map((member,key)=>({...blankRow(key,member.agent,member.role??'worker'),...(member.name?{name:member.name}:{}),
    variant:hermesVariantOf(member)??'',model:member.model??'',provider:member.provider??'',
    custom:!!member.model&&!TEAM_MODEL_CHOICES[member.agent].some(choice=>choice.model===member.model&&(choice.provider??'')===(member.provider??'')),
    effort:member.effort??'',task:member.task??'',sessionId:member.sessionId??'',surface:member.surface??'internal',
    accountId:member.accountId??'',bypass:member.bypassPermissions===true,options:{...member.launchOptions},computerUse:member.computerUseApprovals===true}));
}
/** A running Workroom of this project that may join. `linked`: it runs in its own worktree, so it may take work, not only review.
 * `checkout`: which folder it runs in — sessions sharing one share a worktree, and only one of them may take work there. */
export interface TeamOpenSession {id:string;agent:AiTerminalAgent;label:string;linked:boolean;checkout?:string}
// Read without selecting any (src/teamAccountChoices.ts): the Workroom's own picker writes the project's binding, so it is not reused here.
export type {TeamAccountChoices};

/**
 * Why a row cannot become a member as chosen. The row keeps its choice either way: a chosen account that is not on the list,
 * an unreadable list, or an AI or place that takes no account is refused, never quietly replaced by the default login.
 */
export type TeamRowProblem='invalid-model'|'variant-missing'|'variant-workroom-only'|'account-not-here'|'accounts-unavailable'|'account-unlisted'|'session-missing';
/**
 * A row as create_team receives it, its values as chosen: whatever the place or the AI does not take is left for the shared parser
 * (teamLeaderInstruction → parseTeamMemberSelection) to refuse instead of being dropped here. An open session joins as it runs,
 * so the launch choices the row still holds are not part of it.
 */
export function teamRowMember(row:TeamBuilderRow,context:{open?:TeamOpenSession;accounts?:TeamAccountChoices;variants:readonly HermesVariantItem[]}):{member:TeamLeaderMember;problem?:undefined}|{problem:TeamRowProblem;member?:undefined}{
  const task=row.task.trim(),role=row.role==='reviewer'?{role:'reviewer' as const}:{},open=context.open,name=row.name?{name:row.name}:{};
  if(row.sessionId&&!open)return {problem:'session-missing'};
  if(open)return {member:{agent:open.agent,sessionId:open.id,sessionLabel:open.label,...name,...role,...(task?{task}:{})}};
  if(row.variant&&row.surface!=='internal')return {problem:'variant-workroom-only'};
  const typed=row.model.trim(),typedProvider=row.provider.trim();
  if(row.custom&&(!!typed&&!LAUNCH_MODEL_NAME.test(typed)||row.agent==='hermes'&&!row.variant&&!!typedProvider&&!LAUNCH_MODEL_NAME.test(typedProvider)))return {problem:'invalid-model'};
  if(row.variant&&context.variants.find(item=>item.variant===row.variant)?.available===false)return {problem:'variant-missing'};
  let account:{id:string;label:string}|undefined;
  if(row.accountId){
    if(!teamLaunchSupport(row.surface,row.agent).account)return {problem:'account-not-here'};
    const listed=context.accounts?.[row.agent as CliAccountAgent];
    if(!listed)return {problem:'accounts-unavailable'};
    account=listed.find(item=>item.id===row.accountId);
    if(!account)return {problem:'account-unlisted'};
  }
  // A variant always names its provider (and the provider's first model when the typed one is blank).
  const model=typed||(row.variant?hermesVariantModel(row.variant).model:''),provider=row.variant?HERMES_VARIANT_PROVIDER[row.variant]:typedProvider;
  if(row.agent==='hermes'&&provider&&context.variants.some(item=>item.provider===provider&&item.available===false))return {problem:'variant-missing'};
  return {member:{agent:row.agent,...name,...(model?{model}:{}),...(provider?{provider}:{}),...(row.effort?{effort:row.effort}:{}),...role,...(task?{task}:{}),
    ...(account?{accountId:account.id,accountLabel:account.label}:{}),...(row.bypass?{bypassPermissions:true}:{}),
    ...(row.surface!=='internal'?{surface:row.surface}:{}),...(Object.keys(row.options).length?{launchOptions:{...row.options}}:{}),
    ...(row.computerUse?{computerUseApprovals:true}:{})}};
}
/**
 * The desktop app member opt-in, kept here so the shared i18n table stays untouched. Only one-time approvals, only through
 * an application-scoped computer session that Control still asks the person to approve; never always-allow, bypass,
 * network/full access, login or macOS system prompts.
 */
const COMPUTER_USE_COPY:Readonly<Record<Lang,{label:string;title:string}>>={
  ko:{label:'리더가 이 앱 팀원의 1회성 승인만 컴퓨터 유즈로 응답할 수 있음',title:'켜면 리더가 이 앱의 1회성 승인(이 팀 워크트리의 폴더 신뢰, 한 번 실행)만 그 앱으로 한정한 컴퓨터 유즈로 응답합니다. 세션마다 Control 승인이 따로 필요하고, 항상 허용·권한 우회·네트워크·로그인·시스템 창은 사람이 답합니다.'},
  en:{label:'Leader may answer only this app member\'s one-time approvals with computer use',title:'When on, the leader may answer only this app\'s one-time approvals (folder trust for the team worktree, run once) with computer use limited to that app. Each session still needs approval in Control; always-allow, bypass, network, login and system prompts stay with you.'},
  ja:{label:'リーダーはこのアプリ担当の一回限りの承認だけをコンピューター操作で応答できる',title:'オンにすると、リーダーはこのアプリの一回限りの承認(チームのワークツリーのフォルダー信頼、一度だけ実行)だけを、そのアプリに限ったコンピューター操作で応答します。セッションごとに Control での承認が必要です。常に許可・権限の回避・ネットワーク・ログイン・システムの画面は人が応答します。'},
  'zh-CN':{label:'负责人只能用电脑操作回应此应用成员的一次性批准',title:'开启后，负责人只能用限定于该应用的电脑操作回应其一次性批准（信任团队工作树文件夹、仅运行一次）。每个会话仍需在 Control 中批准；始终允许、绕过权限、网络、登录和系统提示由你处理。'},
  es:{label:'El líder solo puede responder con uso del ordenador a las aprobaciones puntuales de este miembro de app',title:'Activado, el líder solo responde a las aprobaciones puntuales de esta app (confiar en la carpeta del worktree del equipo, ejecutar una vez) con uso del ordenador limitado a esa app. Cada sesión necesita aprobación en Control; permitir siempre, omitir permisos, red, inicio de sesión y avisos del sistema quedan para ti.'},
  fr:{label:'Le chef peut répondre par contrôle de l’ordinateur aux seules approbations ponctuelles de ce membre app',title:'Activé, le chef ne répond qu’aux approbations ponctuelles de cette app (confiance dans le dossier du worktree de l’équipe, exécuter une fois) par un contrôle limité à cette app. Chaque session reste à approuver dans Control ; toujours autoriser, ignorer les autorisations, réseau, connexion et invites système restent à vous.'},
  de:{label:'Leiter darf nur einmalige Freigaben dieses App-Mitglieds per Computersteuerung beantworten',title:'Eingeschaltet beantwortet der Leiter nur einmalige Freigaben dieser App (Ordnervertrauen für das Team-Worktree, einmal ausführen) mit auf diese App begrenzter Computersteuerung. Jede Sitzung braucht weiter eine Freigabe in Control; Immer erlauben, Berechtigungen umgehen, Netzwerk, Anmeldung und Systemdialoge bleiben bei dir.'},
};
/** 빠른 구성: one tap fills the members from the AIs other than the leader. Tasks stay blank — the leader divides the work. */
const PRESETS=[['split',['worker','worker']],['build-review',['worker','reviewer']],['cross-review',['reviewer','reviewer']]] as const;
type Preset=typeof PRESETS[number][0];
const fill=(text:string,values:Record<string,string|number>)=>text.replace(/\{(\w+)\}/g,(token,name)=>Object.hasOwn(values,name)?String(values[name]):token);
// The desktop app is named by its product, the way the project page's app buttons are.
const APP_PRODUCT:Record<AiTerminalAgent,string>={codex:'Codex',claude:'Claude',hermes:'Hermes',agy:'Antigravity'};
const LAUNCH_CHOICES=workroomLaunchChoices();

/**
 * 팀 작전 builder (src/workroomTeam.ts): the person picks members, their models and, when they want, a pinned effort
 * (자동 by default — this Mac's 에포트 자동 decides from each member's task); the AI that receives the composed
 * instruction leads. Each member also takes what 「프로젝트 열기」 offers — where it runs (a Workroom, Orca, cmux, a
 * terminal or the desktop app) and that place's options — and shows whether the team manages it, waits for a connection
 * or needs a person to join it. It only fills the composer — nothing is sent, started or created until the person sends it.
 */
export function WorkroomTeamBuilder({leader,initialGoal,disabled=false,openSessions=[],leaderCheckout,accounts,accountsLoading=false,hermesVariants,onCompose,onClose}:{leader:AiTerminalAgent;initialGoal:string;disabled?:boolean;openSessions?:readonly TeamOpenSession[];leaderCheckout?:string;
  /** Absent for an AI: its list could not be read (or is still being read while `accountsLoading`). */accounts?:TeamAccountChoices;accountsLoading?:boolean;
  /** This Mac's variant items when the parent already has them; otherwise the builder asks. */hermesVariants?:readonly HermesVariantItem[];onCompose:(text:string)=>void;onClose:()=>void}){
  const [lang]=useAppLanguage(),copy=workroomTeamCopy(lang),variantCopy=hermesVariantCopy(lang),computerUseCopy=COMPUTER_USE_COPY[lang]??COMPUTER_USE_COPY.en;
  const asked=useHermesVariants(0,!hermesVariants),variantItems=hermesVariants??asked.items;
  const surfaces=useMemo(()=>teamLaunchSurfacesFor(isWindowsClient()),[]);
  const [initial]=useState(()=>{try{return {...readTeamBuilderDraft(initialGoal),error:''};}catch(reason){return {goal:'',members:undefined,error:reason instanceof Error?reason.message:String(reason)};}});
  const [goal,setGoal]=useState(initial.goal);
  const [rows,setRows]=useState<MemberRow[]>(()=>initial.members?restoredTeamRows(initial.members):AI_TERMINAL_AGENTS.filter(agent=>agent!==leader).slice(0,2).map((agent,key)=>blankRow(key,agent)));
  const [error,setError]=useState(initial.error);
  const nextKey=useRef(rows.length);
  const others=AI_TERMINAL_AGENTS.filter(agent=>agent!==leader);
  const applyPreset=(roles:readonly TeamMemberRole[])=>{setError('');setRows(roles.map((role,index)=>blankRow(nextKey.current++,others[index%others.length]!,role)));};
  const update=(key:number,patch:Partial<MemberRow>)=>{setError('');setRows(current=>current.map(row=>row.key===key?{...row,...patch}:row));};
  const openOf=(row:MemberRow)=>row.sessionId?openSessions.find(session=>session.id===row.sessionId):undefined;
  const variantItem=(variant:HermesVariant|'')=>variant?variantItems.find(item=>item.variant===variant):undefined;
  // Why an open session may only review: it has no worktree of its own, it shares the leader's, or another member
  // already works in that worktree (the host refuses all three — src/workroomTeam.ts attach — this only says so first).
  const reviewOnly=(key:number,open:TeamOpenSession|undefined):'attachedReviewOnly'|'attachedOneWorker'|null=>{
    if(!open)return null;
    if(!open.linked||!!leaderCheckout&&open.checkout===leaderCheckout)return 'attachedReviewOnly';
    return open.checkout&&rows.some(other=>other.key!==key&&other.role==='worker'&&openOf(other)?.checkout===open.checkout)?'attachedOneWorker':null;
  };
  // The AI list names a new Workroom by its AI (or `hermes:<variant>`) and an open one as `session:<id>`. A new AI starts from its
  // model defaults; where it runs, its account and its bypass stay as chosen (compose refuses what the new AI does not take). A
  // Hermes variant chooses a model, which only a Workroom takes: keep an external choice visible and refuse that combination.
  // An open session joins as it runs: the row keeps the rest.
  const pickAgent=(row:MemberRow,value:string)=>{
    const open=value.startsWith('session:')?openSessions.find(session=>session.id===value.slice(8)):undefined;
    if(open)return update(row.key,{agent:open.agent,sessionId:open.id,role:reviewOnly(row.key,open)?'reviewer':row.role});
    const {agent,variant}=launchChoiceTarget(value),surface=row.surface;
    update(row.key,{agent,sessionId:'',variant:variant??'',model:'',provider:'',custom:false,effort:'',surface,options:teamLaunchDefaults(surface,agent),...(variant?hermesVariantModel(variant):{})});
  };
  // Outside the Workroom only Claude on Orca picks a model and an effort (project open has none elsewhere), so those lists read
  // 「워크룸에서만」. A pinned effort survives the move only when the new place offers it for the model the row keeps: Claude's CLI
  // default offers xhigh/max on Orca (a request there) but not in the Workroom (src/teamEffortCatalog.ts), and a level the list
  // no longer shows would otherwise stay chosen, unseen, until compose refuses it.
  // The account and the bypass stay: compose refuses them where they do not apply, and the row still shows them to change.
  const pickSurface=(row:MemberRow,surface:TeamLaunchSurface)=>{
    const support=teamLaunchSupport(surface,row.agent),model=support.model?row.model:'';
    const effort=support.effort&&row.effort&&effortChoices({...row,model},surface).includes(row.effort)?row.effort:'';
    update(row.key,{surface,options:teamLaunchDefaults(surface,row.agent),...(support.model?{}:{model:'',provider:'',custom:false}),effort});
  };
  // The levels the row can pin: the model and provider it would start with (a variant names both, even before one is typed).
  const effortChoices=(row:MemberRow,surface:TeamLaunchSurface=row.surface)=>teamEffortLevels(row.agent,row.model.trim()||(row.variant?hermesVariantModel(row.variant).model:''),surface,
    row.variant?HERMES_VARIANT_PROVIDER[row.variant]:row.provider.trim()||undefined);
  // Hermes levels depend on the provider (src/teamEffortCatalog.ts): an edited provider keeps a pin it still offers and clears
  // one it does not, so the list never shows 「자동」 over a level compose would then refuse.
  const pickProvider=(row:MemberRow,provider:string)=>{
    const effort=row.effort&&effortChoices({...row,provider}).includes(row.effort)?row.effort:'';
    update(row.key,{provider,effort});
  };
  const setOption=(row:MemberRow,patch:TeamLaunchOptions)=>update(row.key,{options:normalizeTeamLaunchOptions(row.surface,row.agent,{...row.options,...patch})});
  const problemText=(problem:TeamRowProblem,index:number,row:MemberRow)=>{
    const n=index+1;
    switch(problem){
     case 'invalid-model':return fill(copy.invalidModel,{n});
     case 'variant-missing':return fill(copy.variantMissing,{n,provider:variantItem(row.variant)?.provider??row.provider});
     case 'session-missing':return `팀원 ${n}: 선택한 열린 세션을 확인하지 못했습니다. 세션을 다시 선택해 주세요.`;
     case 'variant-workroom-only':return copy.variantWorkroomOnly;
     case 'account-not-here':return fill(copy.accountNotHere,{n});
     case 'accounts-unavailable':return fill(copy.accountsUnavailable,{n});
     case 'account-unlisted':return fill(copy.accountMissing,{n});
    }
  };
  const compose=()=>{
    if(!goal.trim()){setError(copy.needGoal);return;}
    const members:TeamLeaderMember[]=[];
    for(const [index,row] of rows.entries()){
     const result=teamRowMember(row,{open:openOf(row),accounts,variants:variantItems});
     if(result.problem){setError(problemText(result.problem,index,row));return;}
     members.push(result.member);
    }
    // The selection block is checked by the same parser create_team uses: a choice it would refuse composes nothing.
    let text:string;
    try{text=teamLeaderInstruction({goal,members});}catch(reason){setError(reason instanceof Error?reason.message:String(reason));return;}
    setError('');
    onCompose(text);
  };
  const label=(index:number,field:string)=>`${copy.members} ${index+1} · ${field}`;
  // A variant lists only its provider's presets (no CLI default — the variant is that provider).
  const modelChoices=(row:MemberRow)=>TEAM_MODEL_CHOICES[row.agent].map((choice,index)=>({choice,index})).filter(({choice})=>!row.variant||choice.provider===HERMES_VARIANT_PROVIDER[row.variant]);
  // The model list shows a preset by its index, '' for the CLI default, 'custom' while the person types one.
  const modelValue=(row:MemberRow)=>row.custom?'custom':row.model?String(TEAM_MODEL_CHOICES[row.agent].findIndex(choice=>choice.model===row.model&&(choice.provider??'')===row.provider)):'';
  const pickModel=(row:MemberRow,value:string)=>{
    if(value==='custom')return update(row.key,{custom:true,effort:''});
    const choice=value===''?undefined:TEAM_MODEL_CHOICES[row.agent][Number(value)];
    update(row.key,{custom:false,model:choice?.model??'',provider:choice?.provider??'',effort:''});
  };
  const choiceLabel=(choice:string)=>{const {agent,variant}=launchChoiceTarget(choice);return variant?`${TEAM_AGENT_LABEL.hermes} · ${HERMES_VARIANT_NAME[variant]}`:TEAM_AGENT_LABEL[agent];};
  const surfaceLabel=(surface:TeamLaunchSurface,agent:AiTerminalAgent)=>surface==='internal'?copy.surfaceWorkroom:surface==='orca-floating'?`Orca · ${copy.surfaceFloating}`
    :surface==='orca-worktree'?`Orca · ${copy.surfaceSidebar}`:surface==='app'?fill(copy.surfaceApp,{app:APP_PRODUCT[agent]}):TEAM_SURFACE_NAME[surface];
  // Every pinned level reads 「고정 · …」; xhigh, max and ultra keep the CLI's own word (팀 현황 uses the same words).
  const effortLabel:Record<WorkroomEffortLevel,string>={low:`${copy.effortLow} · low`,medium:`${copy.effortMedium} · medium`,high:`${copy.effortHigh} · high`,
    xhigh:fill(copy.effortPinned,{level:'xhigh'}),max:fill(copy.effortPinned,{level:'max'}),ultra:fill(copy.effortPinned,{level:'ultra'})};
  const appModeLabel:Record<TeamAppMode,string>={new:copy.appModeNew,reopen:copy.appModeReopen,open:copy.appModeOpen};
  const managementLabel:Record<TeamLaunchManagement,string>={managed:copy.managed,'awaiting-connection':copy.awaiting,manual:copy.manual};
  const reasonLabel:Record<TeamLaunchManagementReason,string>={workroom:copy.reasonWorkroom,'orca-cli':copy.reasonOrca,'cmux-control':copy.reasonCmux,'claude-bg':copy.reasonBg,
    'app-prefill':copy.reasonAppPrefill,'app-open':copy.reasonAppOpen,terminal:copy.reasonTerminal};
  const presetCopy:Record<Preset,[string,string]>={split:[copy.presetSplit,copy.presetSplitTitle],'build-review':[copy.presetBuildReview,copy.presetBuildReviewTitle],'cross-review':[copy.presetCrossReview,copy.presetCrossReviewTitle]};
  return <section className="workroom-team" role="group" aria-label={copy.heading} data-testid="workroom-team-builder"
    onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing){event.stopPropagation();onClose();}}}>
   <header className="workroom-team__head"><strong><Users size={14} aria-hidden="true"/>{copy.heading}</strong><span data-testid="workroom-team-leader">{fill(copy.leader,{leader:TEAM_AGENT_LABEL[leader]})}</span>
    <button type="button" className="workroom-team__icon" aria-label={copy.cancel} onClick={onClose}><X size={14}/></button></header>
   <label className="workroom-team__goal">{copy.goal}<textarea value={goal} rows={2} disabled={disabled} placeholder={copy.goalPlaceholder} onChange={event=>{setError('');setGoal(event.target.value);}}/></label>
   <div className="workroom-team__presets" role="group" aria-label={copy.presets}><span>{copy.presets}</span>
    {PRESETS.map(([preset,roles])=><button type="button" key={preset} data-testid={`workroom-team-preset-${preset}`} title={presetCopy[preset][1]} disabled={disabled} onClick={()=>applyPreset(roles)}>{presetCopy[preset][0]}</button>)}
   </div>
   <fieldset className="workroom-team__members" disabled={disabled}><legend>{copy.members}</legend>
    {rows.map((row,index)=>{
     const support=teamLaunchSupport(row.surface,row.agent),{management,reason}=teamLaunchManagement(row.surface,row.agent,row.options);
     // A chosen account stays visible wherever it is, so the person can see why compose refuses it and set it back.
     const known=accounts?.[row.agent as CliAccountAgent],listed=support.account?known:undefined,chosen=row.accountId?known?.find(item=>item.id===row.accountId):undefined;
     const accountWrong=!!row.accountId&&(!support.account||!chosen),variantWrong=!!row.variant&&row.surface!=='internal';
     return <div className="workroom-team__row" key={row.key} data-testid="workroom-team-member">
     <span className="workroom-team__index" aria-hidden="true">{index+1}</span>
     {/* Another AI has other models and levels (Antigravity's effort is its model variant): a new AI starts from its defaults. */}
     <select aria-label={label(index,copy.agent)} value={row.sessionId?`session:${row.sessionId}`:launchChoiceId(row.agent,row.variant||null)} onChange={event=>pickAgent(row,event.target.value)}>
      {LAUNCH_CHOICES.map(choice=>{
       const item=variantItems.find(entry=>entry.choice===choice),missing=item&&!item.available;
       return <option key={choice} value={choice} disabled={!!missing}>{choiceLabel(choice)}{missing?` · ${fill(variantCopy.missingShort,{provider:item.provider})}`:''}</option>;
      })}
      {openSessions.length>0&&<optgroup label={copy.openSessions}>{openSessions.map(session=><option key={session.id} value={`session:${session.id}`}
        disabled={rows.some(other=>other.key!==row.key&&other.sessionId===session.id)}>{session.label}</option>)}</optgroup>}
     </select>
     {row.sessionId?<span className="workroom-team__attached" data-testid="workroom-team-attached">{copy.attachedModel}</span>
     :!support.model?<>
      {/* Project open takes no model or effort on this surface (only the Workroom and Claude on Orca do): the app or terminal keeps its own. */}
      <select aria-label={label(index,copy.model)} value="" disabled title={copy.workroomOnlyTitle}><option value="">{copy.workroomOnly}</option></select>
      <select className="workroom-team__effort" aria-label={label(index,copy.effort)} value="" disabled title={copy.workroomOnlyTitle}><option value="">{copy.workroomOnly}</option></select></>
     :<>
     <select aria-label={label(index,copy.model)} value={modelValue(row)} onChange={event=>pickModel(row,event.target.value)}>
      {!row.variant&&<option value="">{copy.modelPlaceholder}</option>}
      {modelChoices(row).map(({choice,index:i})=>{const missing=row.agent==='hermes'&&variantItems.some(item=>item.provider===choice.provider&&!item.available);return <option key={choice.label} value={String(i)} disabled={missing}>{choice.label}{missing?` · ${fill(variantCopy.missingShort,{provider:choice.provider??''})}`:''}</option>;})}
      <option value="custom">{copy.modelCustom}</option>
     </select>
     {support.effort
      ?<select className="workroom-team__effort" aria-label={label(index,copy.effort)} title={teamEffortIsRequest(row.agent,row.surface)?copy.effortRequested:undefined} value={row.effort} onChange={event=>{const effort=event.target.value as MemberRow['effort'];update(row.key,{effort,...(row.agent==='agy'&&effort?{model:row.model.replace(/-(low|medium|high|xhigh|max)$/,`-${effort}`)}:{})});}}>
        <option value="">{row.agent==='agy'?copy.effortInModel:row.surface!=='internal'?copy.effortDefault:copy.effortAuto}</option>
        {effortChoices(row).map(level=><option key={level} value={level}>{effortLabel[level]}</option>)}
       </select>
      :<select className="workroom-team__effort" aria-label={label(index,copy.effort)} value="" disabled title={copy.effortInModelTitle}><option value="">{copy.effortInModel}</option></select>}</>}
     <button type="button" className="workroom-team__icon" aria-label={fill(copy.remove,{n:index+1})} disabled={rows.length<=1} onClick={()=>setRows(current=>current.filter(item=>item.key!==row.key))}><X size={13}/></button>
     {row.custom&&support.model&&<div className="workroom-team__custom">
      <input aria-label={label(index,copy.modelName)} value={row.model} placeholder={copy.modelName} spellCheck={false} autoCapitalize="off" onChange={event=>update(row.key,{model:event.target.value,effort:''})}/>
      {/* A variant's provider is the variant itself; plain Hermes types one. */}
      {row.agent==='hermes'&&!row.variant&&<input aria-label={label(index,copy.provider)} value={row.provider} placeholder={copy.providerPlaceholder} spellCheck={false} autoCapitalize="off" onChange={event=>pickProvider(row,event.target.value)}/>}
     </div>}
     {/* Where it runs and with what: only the options project open has on that surface for that AI. An open session keeps its own. */}
     {!row.sessionId&&<div className="workroom-team__launch" data-testid="workroom-team-launch">
      <select className="workroom-team__surface" aria-label={label(index,copy.surface)} aria-invalid={variantWrong||undefined} value={row.surface} onChange={event=>pickSurface(row,event.target.value as TeamLaunchSurface)}>
       {surfaces.map(surface=><option key={surface} value={surface} disabled={!!row.variant&&surface!=='internal'} title={row.variant&&surface!=='internal'?copy.variantWorkroomOnly:undefined}>{surfaceLabel(surface,row.agent)}</option>)}
      </select>
      {variantWrong&&<span className="workroom-team__reason" role="status" data-testid="workroom-team-variant-surface-error">{copy.variantWorkroomOnly}</span>}
      {/* Without a list (still reading, unreadable, or a host that has none) only this Mac's default stays, and the row says so:
          an unread list is never shown as 「no other accounts」. A choice already made stays changeable so it can be set back. */}
      {(support.account||!!row.accountId)&&<select aria-label={label(index,copy.account)} aria-invalid={accountWrong||undefined} value={row.accountId} disabled={!listed&&!row.accountId} onChange={event=>update(row.key,{accountId:event.target.value})}>
       <option value="">{copy.accountHostDefault}</option>
       {/* '' already is this Mac's own login, so the host's entry for it is not listed twice. */}
       {(listed??[]).filter(account=>account.id!==HOST_CLI_ACCOUNT_ID||row.accountId===HOST_CLI_ACCOUNT_ID).map(account=><option key={account.id} value={account.id}>{account.label}</option>)}
       {!!row.accountId&&!listed?.some(item=>item.id===row.accountId)&&<option value={row.accountId}>{chosen?.label??copy.accountUnlisted}</option>}
      </select>}
      {support.appModes.length>0&&<select aria-label={label(index,copy.appMode)} value={row.options.appMode??support.appModes[0]} onChange={event=>setOption(row,{appMode:event.target.value as TeamAppMode})}>
       {support.appModes.map(mode=><option key={mode} value={mode}>{appModeLabel[mode]}</option>)}
      </select>}
      {(support.bypass||row.bypass)&&<label className="workroom-team__check" title={copy.bypassTitle}><input type="checkbox" aria-label={label(index,copy.bypass)} aria-invalid={!support.bypass||undefined} checked={row.bypass} onChange={event=>update(row.key,{bypass:event.target.checked})}/>{copy.bypass}</label>}
      {/* Desktop app members only, default off. A choice left on after a move away from the app stays visible for compose to refuse. */}
      {(row.surface==='app'||!!row.computerUse)&&<label className="workroom-team__check" title={computerUseCopy.title} data-testid="workroom-team-computer-use"><input type="checkbox" aria-label={label(index,computerUseCopy.label)} aria-invalid={row.surface!=='app'||undefined} checked={row.computerUse===true} onChange={event=>update(row.key,{computerUse:event.target.checked})}/>{computerUseCopy.label}</label>}
      {/* Product flags keep their own names in every language. */}
      {support.bg&&<label className="workroom-team__check"><input type="checkbox" aria-label={label(index,'Claude --bg')} checked={row.options.bgMode===true} onChange={event=>setOption(row,{bgMode:event.target.checked})}/>Claude --bg</label>}
      {support.tmux&&<label className="workroom-team__check"><input type="checkbox" aria-label={label(index,'tmux')} checked={row.options.tmuxMode===true} disabled={row.options.bgMode===true} onChange={event=>setOption(row,{tmuxMode:event.target.checked})}/>tmux</label>}
      {support.reuse&&(available=>
       <label className="workroom-team__check" title={available?undefined:copy.reuseUnavailable}><input type="checkbox" aria-label={label(index,copy.reuse)} checked={row.options.reuse==='reuse-or-new'} disabled={!available} onChange={event=>setOption(row,{reuse:event.target.checked?'reuse-or-new':'new'})}/>{copy.reuse}</label>
      )(teamLaunchReuseAvailable(row.surface,row.agent,row.options))}
      <span className="workroom-team__management" data-testid="workroom-team-management" data-management={management} title={reasonLabel[reason]}>{managementLabel[management]}</span>
      {row.surface!=='internal'&&<span className="workroom-team__reason" data-testid="workroom-team-reason">{reasonLabel[reason]}</span>}
      {support.account&&!listed&&<span className="workroom-team__reason" data-testid="workroom-team-accounts-status" data-state={accountsLoading?'loading':'unavailable'}>
       {accountsLoading?copy.accountsLoading:row.accountId?fill(copy.accountsUnavailable,{n:index+1}):copy.accountsUnreadable}</span>}
      {/* Said in the row, not only in a tooltip: this place keeps its own model and effort, and nothing here picks one for it. */}
      {!support.model&&<span className="workroom-team__reason" data-testid="workroom-team-model-elsewhere">{copy.workroomOnlyTitle}</span>}
     </div>}
     {/* A reviewer reads and reports, never edits (src/workroomTeam.ts reviewerBrief); its task is the scope to review. */}
     <div className="workroom-team__taskline">
      <select className="workroom-team__role" aria-label={label(index,copy.role)} value={row.role} onChange={event=>update(row.key,{role:event.target.value as TeamMemberRole})}>
       <option value="worker" disabled={!!reviewOnly(row.key,openOf(row))} title={(k=>k?copy[k]:undefined)(reviewOnly(row.key,openOf(row)))}>{copy.roleWorker}</option><option value="reviewer">{copy.roleReviewer}</option>
      </select>
      <input className="workroom-team__task" aria-label={label(index,copy.task)} value={row.task} placeholder={row.role==='reviewer'?copy.reviewPlaceholder:copy.taskPlaceholder} onChange={event=>update(row.key,{task:event.target.value})}/>
     </div>
    </div>;})}
    <button type="button" className="workroom-team__add" disabled={rows.length>=TEAM_MAX_MEMBERS} onClick={()=>setRows(current=>[...current,blankRow(nextKey.current++,AI_TERMINAL_AGENTS.find(agent=>agent!==leader&&!current.some(row=>row.agent===agent))??'codex')])}><Plus size={13}/>{copy.add}</button>
   </fieldset>
   <p className="workroom-team__hint">{copy.hint}{rows.some(row=>row.role==='reviewer')&&<> {copy.reviewHint}</>}{rows.some(row=>row.sessionId)&&<> {copy.attachedHint}</>}{rows.some(row=>!row.sessionId&&row.surface!=='internal')&&<> {copy.externalHint}</>}</p>
   {error&&<p className="workroom-team__error" role="alert">{error}</p>}
   <div className="workroom-team__actions"><button type="button" className="workroom-team__compose" data-testid="workroom-team-compose" disabled={disabled} onClick={compose}>{copy.compose}</button><button type="button" onClick={onClose}>{copy.cancel}</button></div>
  </section>;
}
