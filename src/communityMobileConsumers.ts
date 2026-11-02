import {createHash,randomUUID} from 'node:crypto';
import {CommunityDeviceAuthorization,CommunityMobileUseSession} from './communityMobilePrincipal';
import type {CommunityMobileRelayPurpose} from './communityAccessClient';
import type {CommunityMobileConsumers,CommunityMobileEffectGuard,CommunityMobilePrincipal} from './communityMobileControlTypes';
import type {RemoteTeamStore,RemoteTeamProject} from './remoteTeamHost';
import {parseRemoteTeamMember,type RemoteTeamMember} from './remoteTeamProtocol';
import type {Team,TeamEffectGuard,WorkroomTeamService} from './workroomTeam';
import type {AiTerminalService,AiTerminalEffortPolicy} from './aiTerminalService';
import type {WorkroomBrowserHost} from './workroomBrowserHost';
import type {CommunityAdapterAuthorization} from './communityAdapterAuthorization';
import type {WorkroomEffortSettingStore} from './workroomEffortSetting';

type Workroom={sessionId:string;targetId:string;label:string;isCurrent():boolean};
export interface CommunityMobileConsumerDependencies {
  /** Actual enabled OPS target adapter, never the general API or a synthetic desktop endpoint. */
  agent?:CommunityMobileConsumers;
  teams:{store:RemoteTeamStore;service():WorkroomTeamService;projects():Promise<RemoteTeamProject[]>;authorizeOwn():Promise<{grantScope:string;active():boolean}>};
  terminal:Pick<AiTerminalService,'reevaluateCommonEffort'|'workspaceEffort'|'runningSession'>;
  workrooms():Promise<Workroom[]>;
  browser:Pick<WorkroomBrowserHost,'mobileContexts'|'mobileAgent'>;
  adapter:CommunityAdapterAuthorization;
  effortSetting:WorkroomEffortSettingStore;
  now?:()=>number;
}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('모바일 기능 요청을 확인하세요.');return v as Record<string,unknown>;};
const exact=(v:Record<string,unknown>,keys:string[])=>{if(Object.keys(v).sort().join(',')!==keys.sort().join(','))throw Error('허용된 모바일 기능 형식이 아닙니다.');};
const text=(v:unknown,max:number)=>{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v)>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))throw Error('모바일 입력 범위를 확인하세요.');return v;};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const display=(v:string,max:number)=>{let out='';for(const c of v){if(Buffer.byteLength(out+c)>max)break;out+=c;}return out;};
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Scope={kind:'teams'|'agent-settings'|'browser';owner:string;receiver:string;project?:string;identity?:string;grant?:string;ref?:string;generation?:string;session?:string;target?:string;workspace?:string;epoch?:number};
type MobileTeamRef={id:string;owner:string;project:string;identity:string;generation:string;request:string;team:string|null;cancelled:number};
type BackendReceipt={scope:string;fingerprint:string;createdAt:number;response:string|null};
const descriptors={
  'mobile-teams':[{op:'projects',mode:'query',label:'허용된 팀 프로젝트'},{op:'create',mode:'effect',label:'새 팀원 시작'},{op:'status',mode:'query',label:'내 팀 상태'},{op:'instruct',mode:'effect',label:'내 팀에 지시'},{op:'cancel',mode:'effect',label:'내 팀 중지'}],
  'mobile-agent-settings':[{op:'contexts',mode:'query',label:'허용된 워크룸'},{op:'status',mode:'query',label:'현재 CLI 에포트 정책'},{op:'evaluate',mode:'effect',label:'기존 CLI 정책으로 에포트 재평가'}],
  'mobile-browser':[{op:'contexts',mode:'query',label:'현재 허용된 내장 브라우저'},{op:'observe',mode:'query',label:'현재 페이지 확인'},{op:'click',mode:'effect',label:'확인한 요소 클릭'},{op:'fill',mode:'effect',label:'확인한 입력란 채우기'},{op:'select',mode:'effect',label:'확인한 목록 선택'}],
} as const;

/** Shared mobile launch provenance: a selected communication/Teams scope alone never enables CLI effort auto. */
export function communityMobileWorkroomEffortPolicy(adapter:CommunityAdapterAuthorization,p:CommunityMobilePrincipal,g:CommunityMobileEffectGuard,now:()=>number=Date.now):AiTerminalEffortPolicy {
  return async setting=>{
    const peer=()=>CommunityDeviceAuthorization.isVerified(p.receiver)&&CommunityDeviceAuthorization.isVerified(p.mobile)&&CommunityMobileUseSession.isVerified(p.use)&&p.use.authorization===p.mobile
      &&p.receiver.body.deviceKind==='desktop'&&p.mobile.body.deviceKind==='mobile'&&p.receiver.body.communityId===p.mobile.body.communityId&&p.receiver.body.profileId===p.mobile.body.profileId&&p.receiver.authority.origin===p.mobile.authority.origin&&p.receiver.authority.issuerPublicKey===p.mobile.authority.issuerPublicKey
      &&p.receiver.permits('mobile-agent-settings',now())&&p.mobile.permits('mobile-agent-settings',now())&&p.use.permits('mobile-agent-settings',now());
    if(!peer())return{mode:'off',isAuthorized:()=>false,beforeEffect:async()=>false};
    const policy=await adapter.workroomEffortPolicy(setting),w=policy.witness,b=p.receiver.body;
    if(w.communityId!==b.communityId||w.profileId!==b.profileId||w.deviceId!==b.deviceId||w.revision!==b.revision)throw Error('CLI 설정 조정의 실제 수신 Mac 결속이 다릅니다.');
    return{mode:policy.mode,isAuthorized:()=>g.active()&&peer()&&policy.isAuthorized(),beforeEffect:async()=>{await g.beforeEffect();return g.active()&&peer()&&await policy.beforeEffect();}};
  };
}

/** Real purpose consumers below the authenticated carrier. prepare never launches an AI or writes native input. */
export function createCommunityMobileConsumers(deps:CommunityMobileConsumerDependencies):CommunityMobileConsumers {
  const now=deps.now??Date.now,db=deps.teams.store.db;
  db.exec('CREATE TABLE IF NOT EXISTS mobile_team_refs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,project TEXT NOT NULL,identity TEXT NOT NULL,generation TEXT NOT NULL,request TEXT NOT NULL,team TEXT,cancelled INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS mobile_consumer_receipts(owner TEXT NOT NULL,id TEXT NOT NULL,scope TEXT NOT NULL,fingerprint TEXT NOT NULL,createdAt INTEGER NOT NULL,response TEXT,PRIMARY KEY(owner,id));');
  const contexts=new Map<string,{owner:string;receiver:string;kind:string;value:Record<string,unknown>}>();
  const principal=(p:CommunityMobilePrincipal,purpose:CommunityMobileRelayPurpose)=>{
    if(!CommunityDeviceAuthorization.isVerified(p.receiver)||!CommunityDeviceAuthorization.isVerified(p.mobile)||!CommunityMobileUseSession.isVerified(p.use)
      ||p.receiver.body.deviceKind!=='desktop'||p.mobile.body.deviceKind!=='mobile'||p.use.authorization!==p.mobile
      ||p.receiver.body.communityId!==p.mobile.body.communityId||p.receiver.body.profileId!==p.mobile.body.profileId
      ||p.receiver.authority.origin!==p.mobile.authority.origin||p.receiver.authority.issuerPublicKey!==p.mobile.authority.issuerPublicKey
      ||!p.receiver.permits(purpose,now())||!p.mobile.permits(purpose,now())||!p.use.permits(purpose,now()))throw Error('현재 모바일 등록·기능 동의를 확인하세요.');
  };
  // Receipt ownership survives renewable policy revisions. Current capability and local context checks remain separate.
  const receiptReceiver=(p:CommunityMobilePrincipal)=>digest([p.receiver.body.profileId,p.receiver.body.communityId,p.receiver.body.enrollmentId,p.receiver.body.deviceId,p.receiver.body.controlKey,p.receiver.body.keyEpoch]);
  const base=(p:CommunityMobilePrincipal,kind:Scope['kind']):Scope=>({kind,owner:p.mobile.receiptOwnerHash,receiver:receiptReceiver(p)});
  const encode=(s:Scope)=>{const v=JSON.stringify(s);if(Buffer.byteLength(v)>1024)throw Error('모바일 범위가 너무 큽니다.');return v;};
  const token=(p:CommunityMobilePrincipal,kind:string,value:Record<string,unknown>)=>{
    for(const[id,c]of contexts)if(c.owner===p.mobile.receiptOwnerHash&&c.receiver===p.receiver.policyDigest&&c.kind===kind&&JSON.stringify(c.value)===JSON.stringify(value))return id;
    if(contexts.size>=256)throw Error('모바일 대상 목록이 가득 찼습니다. 기존 연결을 정리하세요.');
    const id=randomUUID();contexts.set(id,{owner:p.mobile.receiptOwnerHash,receiver:p.receiver.policyDigest,kind,value});return id;
  };
  const context=(p:CommunityMobilePrincipal,kind:string,id:unknown)=>{const c=typeof id==='string'?contexts.get(id):undefined;if(!c||c.owner!==p.mobile.receiptOwnerHash||c.receiver!==p.receiver.policyDigest||c.kind!==kind)throw Error('현재 선택한 모바일 대상을 다시 확인하세요.');return c.value;};
  const projects=async(p:CommunityMobilePrincipal)=>{const scope=await deps.teams.authorizeOwn();if(scope.grantScope!==digest([p.receiver.body.communityId,p.receiver.body.enrollmentId,p.receiver.body.controlKey])||!scope.active())throw Error('현재 Teams Native 동의를 확인하세요.');return{scope,rows:(await deps.teams.projects()).filter(p=>deps.teams.store.granted(p,scope.grantScope)&&(p.isCurrent?.()??true))};};
  const workroom=async(s:Scope)=>{const rows=(await deps.workrooms()).filter(r=>r.sessionId===s.session&&r.targetId===s.target);const row=rows.length===1?rows[0]:undefined;return row&&typeof row.isCurrent==='function'&&row.isCurrent()&&deps.terminal.runningSession(s.session!)?.targetId===s.target?row:null;};
  const allowed=async(p:CommunityMobilePrincipal,purpose:CommunityMobileRelayPurpose,s:Scope)=>{
    principal(p,purpose);if(s.owner!==p.mobile.receiptOwnerHash||s.receiver!==receiptReceiver(p)||`mobile-${s.kind}`!==purpose)return false;
    if(s.kind==='teams'){
      const current=await projects(p);if(!s.project)return true;
      if(s.ref){const ref=teamRef(p,s.ref,s.generation);if(ref.project!==s.project||ref.identity!==s.identity)return false;}
      return current.scope.grantScope===s.grant&&current.rows.some(r=>r.projectId===s.project&&r.identity===s.identity);
    }
    if(s.kind==='agent-settings')return !s.session||!!await workroom(s);
    return !s.workspace||deps.browser.mobileContexts().some(c=>c.workspaceId===s.workspace&&c.epoch===s.epoch&&c.sessionId===s.session&&c.targetId===s.target);
  };
  const effectPolicy=(p:CommunityMobilePrincipal,g:CommunityMobileEffectGuard)=>communityMobileWorkroomEffortPolicy(deps.adapter,p,g,now);
  const check=async(p:CommunityMobilePrincipal,purpose:CommunityMobileRelayPurpose,s:Scope,g:CommunityMobileEffectGuard)=>{await g.beforeEffect();if(!g.active()||!await allowed(p,purpose,s))throw Error('현재 모바일 대상 권한이 변경되었습니다.');};
  const receipt=(owner:string,id:string)=>db.query('SELECT scope,fingerprint,createdAt,response FROM mobile_consumer_receipts WHERE owner=? AND id=?').get(owner,id) as BackendReceipt|null;
  const teamRef=(p:CommunityMobilePrincipal,id:unknown,generation:unknown)=>{
    if(!uuid(id)||!uuid(generation))throw Error('모바일 팀 실행 기록을 확인하세요.');
    const ref=db.query('SELECT * FROM mobile_team_refs WHERE id=?').get(id) as MobileTeamRef|null;
    if(!ref||ref.owner!==p.mobile.receiptOwnerHash||ref.generation!==generation)throw Error('이 모바일이 만든 팀 실행 기록이 아닙니다.');return ref;
  };
  const team=(r:MobileTeamRef):Team|null=>{
    const service=deps.teams.service(),t=r.team?service.store.get(r.team):service.store.byRequest(r.request);
    if(!t)return null;if(t.projectId!==r.project||t.members.length!==1||t.members[0]?.remote||t.members[0]?.attached)throw Error('원래 모바일 팀의 프로젝트 결속을 확인하세요.');return t;
  };
  const teamStatus=(r:MobileTeamRef)=>{
    const t=team(r);if(!t)return{ref:r.id,generation:r.generation,state:'unknown'};
    deps.teams.service().refreshMembers(t);const m=t.members[0]!;return{ref:r.id,generation:r.generation,state:t.state==='closed'?'closed':m.state,delivery:m.delivery??'unknown',...(m.report?{report:{status:m.report.status,summary:m.report.summary.slice(0,4000)}}:{})};
  };
  const execute=async(p:CommunityMobilePrincipal,purpose:CommunityMobileRelayPurpose,s:Scope,command:Record<string,unknown>,g:CommunityMobileEffectGuard,work:()=>Promise<unknown>)=>{
    await check(p,purpose,s,g);if(!g.operationId||g.createdAt===null||!Number.isSafeInteger(g.createdAt)||!/^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(g.operationId)||Number.parseInt(g.operationId.slice(0,8)+g.operationId.slice(9,13),16)!==g.createdAt)throw Error('원래 모바일 작업 영수증이 필요합니다.');
    const scope=encode(s),fingerprint=digest([purpose,g.createdAt,command]),old=receipt(s.owner,g.operationId);
    if(old){if(old.scope!==scope||old.fingerprint!==fingerprint)throw Error('같은 모바일 작업 ID의 내용이 바뀌었습니다.');return old.response?JSON.parse(old.response):{outcome:'unknown'};}
    if((db.query('SELECT count(*) AS n FROM mobile_consumer_receipts').get() as {n:number}).n>=4096)throw Error('모바일 기능 영수증이 가득 찼습니다.');
    db.query('INSERT INTO mobile_consumer_receipts(owner,id,scope,fingerprint,createdAt) VALUES(?,?,?,?,?)').run(s.owner,g.operationId,scope,fingerprint,g.createdAt);
    const result=await work();if(Buffer.byteLength(JSON.stringify(result))>16_000)throw Error('결과 크기를 확인하지 못했습니다. 원래 영수증만 조회하세요.');
    db.query('UPDATE mobile_consumer_receipts SET response=? WHERE owner=? AND id=?').run(JSON.stringify(result),s.owner,g.operationId);return result;
  };
  const result:CommunityMobileConsumers={
    capabilities(purpose){return purpose==='mobile-agent'?deps.agent?.capabilities(purpose)??[]:descriptors[purpose];},
    async authorizeReceipt(p,purpose,raw){
      if(purpose==='mobile-agent')return deps.agent?.authorizeReceipt(p,purpose,raw)??false;
      try{if(Buffer.byteLength(raw)>1024)return false;return await allowed(p,purpose,object(JSON.parse(raw)) as unknown as Scope);}catch{return false;}
    },
    async readReceipt(p,purpose,raw,id,createdAt){
      if(purpose==='mobile-agent')return deps.agent?.readReceipt?.(p,purpose,raw,id,createdAt)??{state:'unknown'};
      if(!await result.authorizeReceipt(p,purpose,raw))throw Error('원래 모바일 영수증 범위가 바뀌었습니다.');
      const old=receipt(p.mobile.receiptOwnerHash,id);return old?.scope===raw&&old.createdAt===createdAt&&old.response?{state:'result',result:JSON.parse(old.response)}:{state:'unknown'};
    },
    async prepare(p,purpose,mode,wire){
      principal(p,purpose);if(purpose==='mobile-agent'){if(!deps.agent)throw Error('현재 Main의 AI 요청 기능이 연결되지 않았습니다.');return deps.agent.prepare(p,purpose,mode,wire);}
      const c=object(wire),kind=purpose.slice(7) as Scope['kind'];if(c.kind!==kind)throw Error('모바일 기능과 명령 종류가 다릅니다.');
      const descriptor=descriptors[purpose].find(d=>d.op===c.op&&d.mode===mode);if(!descriptor)throw Error('현재 Main이 제공하지 않는 모바일 명령입니다.');
      let s=base(p,kind),work:(g:CommunityMobileEffectGuard)=>Promise<unknown>;
      if(kind==='teams'){
        if(c.op==='projects'){
          exact(c,c.cursor===undefined?['kind','op']:['kind','op','cursor']);const cursor=c.cursor===undefined?null:context(p,'team-project-page',c.cursor);work=async g=>{await check(p,purpose,s,g);const {rows}=await projects(p);let start=0;if(cursor){const index=rows.findIndex(r=>r.projectId===cursor.project&&r.identity===cursor.identity);if(index<0)throw Error('프로젝트 목록이 바뀌었습니다. 처음부터 다시 확인하세요.');start=index+1;}const page=rows.slice(start,start+32),last=page.at(-1);return{projects:page.map(r=>({context:token(p,kind,{project:r.projectId,identity:r.identity}),name:display(r.name,120)})),...(last&&start+page.length<rows.length?{nextCursor:token(p,'team-project-page',{project:last.projectId,identity:last.identity})}:{})};};
        }else{
          let ref:MobileTeamRef|undefined,member:RemoteTeamMember|undefined;
          if(c.op==='create'){
            exact(c,['kind','op','project','title','goal','member']);const selected=context(p,kind,c.project),{scope,rows}=await projects(p),project=rows.find(r=>r.projectId===selected.project&&r.identity===selected.identity);
            if(!project)throw Error('현재 허용된 프로젝트를 다시 선택하세요.');text(c.title,240);text(c.goal,6000);member=parseRemoteTeamMember(c.member);
            s={...s,project:project.projectId,identity:project.identity,grant:scope.grantScope};
          }else{
            exact(c,c.op==='instruct'?['kind','op','ref','generation','text']:['kind','op','ref','generation']);if(c.op==='instruct')text(c.text,4000);
            ref=teamRef(p,c.ref,c.generation);const {scope}=await projects(p);s={...s,project:ref.project,identity:ref.identity,grant:scope.grantScope,ref:ref.id,generation:ref.generation};
          }
          work=async g=>{
            await check(p,purpose,s,g);if(c.op==='status')return teamStatus(ref!);
            return execute(p,purpose,s,c,g,async()=>{
              const guard:TeamEffectGuard={active:()=>g.active()&&(!ref||(db.query('SELECT cancelled FROM mobile_team_refs WHERE id=?').get(ref.id) as {cancelled:number}|null)?.cancelled===0),beforeEffect:()=>check(p,purpose,s,g),effortPolicy:effectPolicy(p,g)};
              if(c.op==='create'){
                const request=`mobile-team-${digest([s.owner,g.operationId]).slice(0,48)}`;
                ref={id:randomUUID(),owner:s.owner,project:s.project!,identity:s.identity!,generation:randomUUID(),request,team:null,cancelled:0};
                db.query('INSERT INTO mobile_team_refs VALUES(?,?,?,?,?,?,NULL,0)').run(ref.id,ref.owner,ref.project,ref.identity,ref.generation,ref.request);
                const created=await deps.teams.service().create({op:'create',portId:s.project!,requestId:request,title:c.title as string,goal:c.goal as string,members:[{...member!,surface:'internal'}]},null,guard);
                ref.team=created.team.id;db.query('UPDATE mobile_team_refs SET team=? WHERE id=?').run(ref.team,ref.id);return{outcome:'accepted',ref:ref.id,generation:ref.generation};
              }
              const t=team(ref!),m=t?.members[0];if(!t||!m||!m.sessionId||!m.targetId||m.execution?.kind!=='workroom')throw Error('이 모바일 작업이 만든 실제 워크룸을 확인하지 못했습니다.');
              if(c.op==='instruct')return{outcome:'instructed',delivery:await deps.teams.service().host.instruct({sessionId:m.sessionId,prompt:c.text as string,requestId:`mobile-instruct-${digest([s.owner,g.operationId]).slice(0,48)}`,guard})};
              await guard.beforeEffect();db.query('UPDATE mobile_team_refs SET cancelled=1 WHERE id=?').run(ref!.id);await deps.teams.service().host.close(m.sessionId);m.state='closed';t.state='closed';deps.teams.service().store.save(t);return{outcome:'cancelled'};
            });
          };
        }
      }else if(c.op==='contexts'){
        exact(c,c.cursor===undefined?['kind','op']:['kind','op','cursor']);const cursor=c.cursor===undefined?null:context(p,kind+'-page',c.cursor);work=async g=>{await check(p,purpose,s,g);const rows=kind==='browser'?deps.browser.mobileContexts().map(r=>({value:{workspace:r.workspaceId,epoch:r.epoch,session:r.sessionId,target:r.targetId},label:r.label})):(await deps.workrooms()).filter(r=>r.isCurrent()).map(r=>({value:{session:r.sessionId,target:r.targetId},label:r.label}));let start=0;if(cursor){const index=rows.findIndex(r=>JSON.stringify(r.value)===JSON.stringify(cursor));if(index<0)throw Error('대상 목록이 바뀌었습니다. 처음부터 다시 확인하세요.');start=index+1;}const page=rows.slice(start,start+32),last=page.at(-1);return{contexts:page.map(r=>({context:token(p,kind,r.value),label:display(r.label,120)})),...(last&&start+page.length<rows.length?{nextCursor:token(p,kind+'-page',last.value)}:{})};};
      }else{
        const selected=context(p,kind,c.context);s={...s,...selected};
        if(kind==='agent-settings'){
          exact(c,c.op==='evaluate'?['kind','op','context','text']:['kind','op','context']);if(c.op==='evaluate')text(c.text,4000);
          const bound=await workroom(s);if(!bound)throw Error('현재 허용된 워크룸을 다시 확인하세요.');
          work=async g=>{
            const active=()=>g.active()&&bound.isCurrent()&&deps.terminal.runningSession(s.session!)?.targetId===s.target;
            const guard:CommunityMobileEffectGuard={operationId:g.operationId,createdAt:g.createdAt,active,beforeEffect:async()=>{await check(p,purpose,s,g);if(!active())throw Error('워크룸의 현재 연결 허용이 변경되었습니다.');}};
            await check(p,purpose,s,guard);const policy=await effectPolicy(p,guard)(deps.effortSetting);if(!active()||!policy.isAuthorized())throw Error('현재 CLI 설정 조정 동의를 확인하세요.');
            if(c.op==='status')return deps.terminal.workspaceEffort({targetId:s.target!,sessionId:s.session,effortModes:true,effortExtended:true});
            return execute(p,purpose,s,c,guard,async()=>({outcome:'evaluated',effort:await deps.terminal.reevaluateCommonEffort({targetId:s.target!,sessionId:s.session!,text:c.text as string,active,effortPolicy:effectPolicy(p,guard)})}));};
        }else{
          const fields=['kind','op','context',...(c.op==='observe'?[]:['observationId','selector',...(c.frame!==undefined?['frame']:[]),...(c.op==='fill'?['text']:c.op==='select'?['value']:[])])];exact(c,fields);
          if(c.op!=='observe'){text(c.observationId,64);text(c.selector,1024);if(c.op==='fill')text(c.text,4000);if(c.op==='select')text(c.value,1000);if(c.frame!==undefined&&!/^(main|f[1-9]\d?)$/.test(String(c.frame)))throw Error('확인한 브라우저 프레임이 아닙니다.');}
          work=async g=>{await check(p,purpose,s,g);const witness=await deps.adapter.authorize('computer-use.browser');if(witness.communityId!==p.receiver.body.communityId||witness.profileId!==p.receiver.body.profileId||witness.deviceId!==p.receiver.body.deviceId||witness.revision!==p.receiver.body.revision||!deps.adapter.isCurrent(witness,'computer-use.browser'))throw Error('현재 Native 브라우저 동의를 확인하세요.');
            const request={operation:c.op,...(c.op==='observe'?{}:{observationId:c.observationId,selector:c.selector,requestId:g.operationId,...(c.frame!==undefined?{frame:c.frame}:{}),...(c.op==='fill'?{text:c.text}:c.op==='select'?{value:c.value}:{})})};
            const invoke=()=>deps.browser.mobileAgent(s.workspace!,s.epoch!,request,{active:()=>g.active()&&deps.adapter.isCurrent(witness,'computer-use.browser'),beforeEffect:()=>check(p,purpose,s,g)});
            if(c.op==='observe'){const r=await invoke();if(!r.success)throw Error(r.error);const o=r.workspace?.observation;return{observation:o?{id:o.id,title:display(o.title,180),text:display(o.text,4000),elements:o.elements.filter(e=>Buffer.byteLength(e.selector)<=256).slice(0,8).map(e=>({...e,role:display(e.role,60),name:display(e.name,100),...(e.options?{options:e.options.slice(0,4).map(v=>({...v,label:display(v.label,60),value:display(v.value,60),truncated:true}))}:{})})),truncated:true}:null};}
            return execute(p,purpose,s,c,g,async()=>{const r=await invoke();if(!r.success)throw Error(r.error);return{outcome:r.workspace?.receipt?.state??'unknown'};});};
        }
      }
      if(!await allowed(p,purpose,s))throw Error('현재 모바일 대상 허용을 확인하세요.');
      return{scope:encode(s),run:work};
    },
  };
  return result;
}
