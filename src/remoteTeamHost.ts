import {Database} from 'bun:sqlite';
import {constants,openSync,closeSync,fstatSync,lstatSync,chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseRemoteTeamRequest,parseRemoteTeamManagement,parseRemoteTeamTarget,type RemoteTeamRef,type RemoteTeamResponse,type RemoteTeamRequest,type RemoteTeamStatus} from './remoteTeamProtocol';
import type {Team,TeamEffectGuard,WorkroomTeamService} from './workroomTeam';
import type {CommunityComponentAuthorization} from './communityComponentIdentity';

export interface RemoteTeamProject {projectId:string;name:string;identity:string;isCurrent?:()=>boolean}
export interface RemoteTeamScope {subject:string;deviceId:string;endpointId:string;grantScope:string;active():boolean}
export interface RemoteTeamFrom {deviceId:string;name:string;endpointId?:string}
export class RemoteTeamError extends Error {constructor(readonly code:string,message:string){super(message);}}
function fail(code:string,message:string):never{throw new RemoteTeamError(code,message);}
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Public routing choices require both live community membership and a current issuer-certified Native Teams peer. */
export function remoteTeamDeviceChoices(own:CommunityComponentAuthorization,peers:readonly CommunityComponentAuthorization[],devices:readonly {deviceId:string;endpointId:string}[],now=Date.now()){
  if(!own.permits('teams',now))fail('REMOTE_TEAMS_CONSENT_REQUIRED','현재 Teams 공통 동의를 확인하세요.');
  const directory=new Map<string,CommunityComponentAuthorization>();
  for(const peer of peers){
    if(!peer.permits('teams',now)||peer.body.profileId!==own.body.profileId||peer.body.communityId!==own.body.communityId||peer.body.deviceId===own.body.deviceId)continue;
    if(directory.has(peer.body.agentDeviceId))fail('REMOTE_TEAMS_REF_INVALID','커뮤니티 기기 결속이 중복되어 목록을 만들지 못했습니다.');directory.set(peer.body.agentDeviceId,peer);
  }
  const chosen=new Map<string,string>(),endpoints=new Set<string>();return devices.flatMap(device=>{
    const peer=directory.get(device.deviceId);if(!peer)return[];
    parseRemoteTeamTarget({deviceId:device.deviceId,endpointId:device.endpointId,projectId:'discovery'});
    if(chosen.get(device.deviceId)===device.endpointId)return[];
    if(chosen.has(device.deviceId)||endpoints.has(device.endpointId))fail('REMOTE_TEAMS_REF_INVALID','커뮤니티 기기 끝점 결속이 중복되었습니다.');
    chosen.set(device.deviceId,device.endpointId);endpoints.add(device.endpointId);return[{deviceId:device.deviceId,endpointId:device.endpointId,name:peer.body.name}];
  });
}
type RecordRef={id:string;owner:string;project:string;identity:string;generation:string;request:string;team:string|null;cancelled:number};
type Receipt={fingerprint:string;state:string;response:string|null;ref:string|null;project:string|null;identity:string|null};
const RECEIPT_LIMIT=4096;
/** Receiver-only ledger. It stores private local team mappings, never transport keys or arbitrary commands. */
export class RemoteTeamStore {
  readonly db:Database;
  constructor(file:string|null){
    if(file){
      mkdirSync(dirname(file),{recursive:true,mode:0o700});
      const parent=lstatSync(dirname(file));if(!parent.isDirectory()||parent.isSymbolicLink())fail('REMOTE_TEAMS_STORE_UNSAFE','원격 Teams 저장 위치를 확인하세요.');
      const fd=openSync(file,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
      try{const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||(typeof process.getuid==='function'&&st.uid!==process.getuid())||(st.mode&0o077)!==0)fail('REMOTE_TEAMS_STORE_UNSAFE','원격 Teams 기록의 소유자·권한을 확인하세요.');}finally{closeSync(fd);}
      chmodSync(file,0o600);
    }
    this.db=new Database(file??':memory:',{create:true,strict:true});
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL); INSERT OR IGNORE INTO meta VALUES(1,0); CREATE TABLE IF NOT EXISTS grants(project TEXT PRIMARY KEY,identity TEXT NOT NULL,scope TEXT NOT NULL); CREATE TABLE IF NOT EXISTS refs(id TEXT PRIMARY KEY,owner TEXT NOT NULL,project TEXT NOT NULL,identity TEXT NOT NULL,generation TEXT NOT NULL,request TEXT NOT NULL,team TEXT,cancelled INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS receipts(owner TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,response TEXT,ref TEXT,project TEXT,identity TEXT,PRIMARY KEY(owner,id));');
  }
  close(){this.db.close();}
  revision():number{return (this.db.query('SELECT revision FROM meta WHERE id=1').get() as {revision:number}).revision;}
  granted(project:RemoteTeamProject,scope:string):boolean{const row=this.db.query('SELECT identity,scope FROM grants WHERE project=?').get(project.projectId) as {identity:string;scope:string}|null;return row?.identity===project.identity&&row.scope===scope;}
  set(expected:number,projects:RemoteTeamProject[],scope:string,active:()=>boolean):void{
    this.db.transaction(()=>{if(this.revision()!==expected)fail('REMOTE_TEAMS_REVISION_CONFLICT','허용 목록이 바뀌었습니다. 다시 확인하고 저장하세요.');if(!active())fail('REMOTE_TEAMS_CONSENT_REQUIRED','현재 Teams 공통 동의를 확인하세요.');this.db.exec('DELETE FROM grants');for(const p of projects)this.db.query('INSERT INTO grants VALUES(?,?,?)').run(p.projectId,p.identity,scope);this.db.query('UPDATE meta SET revision=revision+1 WHERE id=1').run();}) (); 
  }
  ref(id:string):RecordRef|null{return this.db.query('SELECT * FROM refs WHERE id=?').get(id) as RecordRef|null;}
  receipt(owner:string,id:string):Receipt|null{return this.db.query('SELECT fingerprint,state,response,ref,project,identity FROM receipts WHERE owner=? AND id=?').get(owner,id) as Receipt|null;}
  prepare(owner:string,id:string,fingerprint:string,ref?:RecordRef,project?:RemoteTeamProject):void{
    this.db.transaction(()=>{
      if((this.db.query('SELECT count(*) AS n FROM receipts').get() as {n:number}).n>=RECEIPT_LIMIT)fail('REMOTE_TEAMS_CAPACITY','원격 Teams 영수증 보관 한도에 도달했습니다. 기존 결과를 확인하세요.');
      if(ref)this.db.query('INSERT INTO refs(id,owner,project,identity,generation,request,team,cancelled) VALUES(?,?,?,?,?,?,NULL,0)').run(ref.id,ref.owner,ref.project,ref.identity,ref.generation,ref.request);
      this.db.query("INSERT INTO receipts(owner,id,fingerprint,state,response,ref,project,identity) VALUES(?,?,?,'started',NULL,?,?,?)").run(owner,id,fingerprint,ref?.id??null,project?.projectId??null,project?.identity??null);
    })();
  }
  settle(owner:string,id:string,response:RemoteTeamResponse):void{this.db.query("UPDATE receipts SET state='settled',response=? WHERE owner=? AND id=?").run(JSON.stringify(response),owner,id);}
}

export interface RemoteTeamHostDependencies {
  store:RemoteTeamStore;service():WorkroomTeamService;
  projects():Promise<RemoteTeamProject[]>;
  /** Current Native teams.run + issuer-verified sender directory binding. No caller-supplied boolean grants it. */
  authorize(from?:RemoteTeamFrom):Promise<RemoteTeamScope>;
  effortPolicy?:(from:RemoteTeamFrom,setting:import('./workroomEffortSetting').WorkroomEffortSettingStore)=>ReturnType<import('./aiTerminalService').AiTerminalEffortPolicy>;
}
export class RemoteTeamHost {
  #chain:Promise<unknown>=Promise.resolve();
  #closed=false;
  constructor(readonly deps:RemoteTeamHostDependencies){}
  close(){this.#closed=true;}
  #serial<T>(work:()=>Promise<T>):Promise<T>{const p=this.#chain.catch(()=>{}).then(work);this.#chain=p;return p;}
  async permissions(){const projects=await this.deps.projects();let scope:RemoteTeamScope|null=null;try{scope=await this.deps.authorize();}catch{}return{revision:this.deps.store.revision(),projects:projects.map(p=>({projectId:p.projectId,name:p.name,allowed:!!scope&&this.deps.store.granted(p,scope.grantScope)})),configured:scope?.active()===true};}
  /** Called only by the Main management route, never by dispatch(). */
  async manage(value:unknown){
    const r=parseRemoteTeamManagement(value);if(r.operation==='permissions')return this.permissions();
    const scope=await this.deps.authorize().catch(()=>fail('REMOTE_TEAMS_CONSENT_REQUIRED','Teams 기능의 공통 등록·동의를 먼저 완료하세요.'));
    const first=await this.deps.projects(),selected=r.projectIds.map(id=>first.find(p=>p.projectId===id)??fail('REMOTE_TEAMS_PROJECT_CHANGED','등록 프로젝트가 바뀌었습니다. 목록을 다시 확인하세요.'));
    const current=await this.deps.projects();if(selected.some(p=>!current.some(q=>q.projectId===p.projectId&&q.identity===p.identity)))fail('REMOTE_TEAMS_PROJECT_CHANGED','등록 프로젝트가 바뀌었습니다. 목록을 다시 확인하세요.');
    this.deps.store.set(r.expectedRevision,selected,scope.grantScope,()=>!this.#closed&&scope.active()&&selected.every(p=>p.isCurrent?.()??true));return this.permissions();
  }
  #wire(ref:RecordRef,scope:RemoteTeamScope):RemoteTeamRef{return{kind:'remote',remoteRef:ref.id,deviceId:scope.deviceId,endpointId:scope.endpointId,generation:ref.generation,projectId:ref.project};}
  #record(wire:RemoteTeamRef,scope:RemoteTeamScope):RecordRef{
    const ref=this.deps.store.ref(wire.remoteRef);
    if(!ref||ref.owner!==scope.subject||wire.deviceId!==scope.deviceId||wire.endpointId!==scope.endpointId||ref.project!==wire.projectId||ref.generation!==wire.generation)fail('REMOTE_TEAMS_REF_INVALID','이 기기·프로젝트의 원격 팀 실행 기록이 아닙니다.');
    return ref;
  }
  #team(ref:RecordRef):Team|null{
    const service=this.deps.service(),team=ref.team?service.store.get(ref.team):service.store.byRequest(ref.request);
    if(!team)return null;if(team.projectId!==ref.project||team.members.length!==1||team.members[0]?.remote)fail('REMOTE_TEAMS_REF_INVALID','원격 실행의 실제 프로젝트·팀 결속을 확인하지 못했습니다.');
    if(!ref.team){this.deps.store.db.query('UPDATE refs SET team=? WHERE id=?').run(team.id,ref.id);ref.team=team.id;}return team;
  }
  async #status(ref:RecordRef,scope:RemoteTeamScope):Promise<RemoteTeamStatus>{
    const team=this.#team(ref),wire=this.#wire(ref,scope);if(!team)return{ref:wire,state:'unknown',delivery:'unknown'};
    this.deps.service().refreshMembers(team);const member=team.members[0]!;
    const state=member.state==='awaiting-connection'||member.state==='awaiting-manual-join'||member.state==='awaiting-ack'?'unknown':member.state;
    return{ref:wire,state,delivery:member.delivery==='verified'?'verified':member.delivery==='not-sent'?'not-sent':'unknown',...(member.report?{report:{status:member.report.status,summary:member.report.summary.slice(0,4000),provenance:member.report.provenance??'member',at:member.report.at}}:{})};
  }
  async #guard(project:RemoteTeamProject,scope:RemoteTeamScope,from:RemoteTeamFrom,ref?:RecordRef):Promise<TeamEffectGuard>{
    const revision=this.deps.store.revision();let current=scope;
    const active=()=>!this.#closed&&current.active()&&this.deps.store.revision()===revision&&this.deps.store.granted(project,current.grantScope)&&(project.isCurrent?.()??true)&&(!ref||!this.deps.store.ref(ref.id)?.cancelled);
    const beforeEffect=async()=>{current=await this.deps.authorize(from);const found=(await this.deps.projects()).find(p=>p.projectId===project.projectId);if(current.subject!==scope.subject||!found||found.identity!==project.identity||!active())fail('REMOTE_TEAMS_CONSENT_REQUIRED','원격 Teams 동의 또는 프로젝트 허용이 변경되었습니다.');};
    await beforeEffect();return{active,beforeEffect,effortPolicy:setting=>this.deps.effortPolicy?this.deps.effortPolicy(from,setting):Promise.resolve({mode:'off',isAuthorized:()=>false,beforeEffect:async()=>false})};
  }
  async dispatch(value:unknown,from:RemoteTeamFrom,controlId:string):Promise<{result:RemoteTeamResponse}>{
    const request=parseRemoteTeamRequest(value);if(!controlId||!from.endpointId)fail('REMOTE_TEAMS_REF_INVALID','인증된 원격 Teams 발신자를 확인하지 못했습니다.');
    return this.#serial(async()=>({result:await this.#execute(request,from)}));
  }
  async #execute(r:RemoteTeamRequest,from:RemoteTeamFrom):Promise<RemoteTeamResponse>{
    if(this.#closed)fail('REMOTE_TEAMS_CONSENT_REQUIRED','원격 Teams 수신을 종료했습니다.');
    const scope=await this.deps.authorize(from);if(!scope.active())fail('REMOTE_TEAMS_CONSENT_REQUIRED','현재 Teams 공통 동의를 확인하세요.');
    if(r.targetDeviceId!==scope.deviceId)fail('REMOTE_TEAMS_REF_INVALID','선택한 Mac과 이 수신 Mac이 다릅니다.');
    const projects=await this.deps.projects(),allowed=projects.filter(p=>this.deps.store.granted(p,scope.grantScope));
    if(r.op==='projects')return{outcome:'projects',projects:allowed.map(p=>({projectId:p.projectId,name:p.name}))};
    const previous='requestId'in r?this.deps.store.receipt(scope.subject,r.requestId):null;
    if(previous?.project&&!allowed.some(p=>p.projectId===previous.project&&p.identity===previous.identity))fail('REMOTE_TEAMS_PROJECT_CHANGED','이 원격 Teams 영수증의 프로젝트 허용을 확인하세요.');
    if(r.op==='receipt')return previous?.response?JSON.parse(previous.response) as RemoteTeamResponse:previous?{outcome:'unknown',...(previous.ref&&this.deps.store.ref(previous.ref)?{ref:this.#wire(this.deps.store.ref(previous.ref)!,scope)}:{})}:{outcome:'missing'};
    if(previous){if(previous.fingerprint!==hash(r))fail('REMOTE_TEAMS_REQUEST_CONFLICT','같은 요청 ID의 내용이 바뀌었습니다.');return previous.response?JSON.parse(previous.response) as RemoteTeamResponse:{outcome:'unknown',...(previous.ref&&this.deps.store.ref(previous.ref)?{ref:this.#wire(this.deps.store.ref(previous.ref)!,scope)}:{})};}
    let ref=r.op==='create'?null:this.#record(r.ref,scope);
    const project=allowed.find(p=>p.projectId===(r.op==='create'?r.projectId:ref!.project));
    if(!project||ref&&ref.identity!==project.identity)fail('REMOTE_TEAMS_PROJECT_CHANGED','받는 Mac에서 이 등록 프로젝트를 먼저 허용하세요.');
    if(r.op==='status')return{outcome:'settled',status:await this.#status(ref!,scope)};
    if(r.op==='create'){
      const id=randomUUID(),request=`remote-team-${hash([scope.subject,r.requestId]).slice(0,48)}`;
      ref={id,owner:scope.subject,project:project.projectId,identity:project.identity,generation:randomUUID(),request,team:null,cancelled:0};
    }
    const guard=await this.#guard(project,scope,from,r.op==='create'?undefined:ref!);
    this.deps.store.prepare(scope.subject,r.requestId,hash(r),r.op==='create'?ref!:undefined,project);
    let response:RemoteTeamResponse;
    try{
      if(r.op==='create'){
        const created=await this.deps.service().create({op:'create',portId:project.projectId,requestId:ref!.request,title:r.title,goal:r.goal,members:[{...r.member,surface:'internal'}]},null,guard);
        ref!.team=created.team.id;this.deps.store.db.query('UPDATE refs SET team=? WHERE id=?').run(ref!.team,ref!.id);
        response={outcome:'settled',status:await this.#status(ref!,scope)};
      }else if(r.op==='instruct'){
        const team=this.#team(ref!);if(!team||team.state!=='active')fail('REMOTE_TEAMS_REF_INVALID','실행 중인 원격 팀을 확인하세요.');
        this.deps.service().refreshMembers(team);const member=team.members[0]!;
        if(!member.sessionId||!member.targetId||member.attached||member.execution?.kind!=='workroom'||this.deps.service().host.session(member.sessionId,member.targetId).state!=='running')fail('REMOTE_TEAMS_REF_INVALID','이 원격 요청이 시작한 워크룸을 확인하지 못했습니다.');
        const delivered=await this.deps.service().host.instruct({sessionId:member.sessionId,prompt:r.text,requestId:`remote-instruct-${hash([scope.subject,r.requestId]).slice(0,48)}`,guard});
        response={outcome:'instructed',delivery:delivered==='written'?'verified':'unknown'};
      }else{
        // A cancellation ends only this receipt's owned PTY. Worktrees, branches and reports remain intact.
        this.deps.store.db.query('UPDATE refs SET cancelled=1 WHERE id=?').run(ref!.id);
        const team=this.#team(ref!),member=team?.members[0];
        if(!member?.sessionId||!member.targetId)response={outcome:'cancelled',closed:team?'not-running':'unknown'};
        else if(member.attached||member.execution?.kind!=='workroom')response={outcome:'cancelled',closed:'unknown'};
        else {await this.deps.service().host.close(member.sessionId);member.state='closed';team!.state='closed';this.deps.service().store.save(team!);response={outcome:'cancelled',closed:'closed'};}
      }
    }catch{response={outcome:'unknown',...(ref?{ref:this.#wire(ref,scope)}:{})};}
    this.deps.store.settle(scope.subject,r.requestId,response);return response;
  }
}
export function createRemoteTeamDispatcher(host:RemoteTeamHost){return(request:Record<string,unknown>,from:RemoteTeamFrom,controlId:string)=>host.dispatch(request,from,controlId);}
