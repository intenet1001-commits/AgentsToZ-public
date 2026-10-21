import type {AiTerminalSummary} from './aiTerminalProtocol';
import type {WorkroomMentionProject} from './workroomProjectMention';
import {workroomSessionLabels} from './workroomSessionLabel';
import type {WorkroomActivityView} from './workroomActivityProtocol';
import {WORKROOM_ACTIVITY_GROUPS,workroomActivityPresentation,type WorkroomActivityGroup,type WorkroomActivityPresentation} from './workroomActivityView';

/** Display inventory only. Every action retains the owning endpoint and opaque session id. */
export interface SessionDirectoryDevice {endpointId:string;deviceId:string;label:string;local:boolean}
export interface SessionDirectoryLoad {projects:WorkroomMentionProject[];sessions:AiTerminalSummary[];opsTargetId?:string|null}
export interface SessionDirectorySnapshot extends SessionDirectoryLoad {
  device:SessionDirectoryDevice;loading:boolean;error:string;observedAt:number|null;
}
export const SESSION_DIRECTORY_MAX_DEVICES=32;
export const SESSION_DIRECTORY_CONCURRENCY=4;
export const sessionDirectoryDeviceKey=(device:SessionDirectoryDevice)=>device.local?'local':device.endpointId;
export const sessionDirectoryRowKey=(device:SessionDirectoryDevice,sessionId:string)=>`${sessionDirectoryDeviceKey(device)}:${sessionId}`;

type Scope={device:SessionDirectoryDevice;token:symbol};
type Job={key:string;scope:Scope;promise:Promise<SessionDirectorySnapshot|null>;resolve:(value:SessionDirectorySnapshot|null)=>void};

/**
 * One inventory request per device, at most four running and 32 queued. A slow or failed Mac
 * preserves its last snapshot; removed/replaced devices cannot publish late replies. Disposal
 * drops only this view's queue and results, never a host terminal or memory-save operation.
 */
export class SessionDirectoryInventory {
  #scopes=new Map<string,Scope>();
  #snapshots=new Map<string,SessionDirectorySnapshot>();
  #flights=new Map<string,Job>();
  #queue:Job[]=[];
  #running=0;
  #disposed=false;
  constructor(readonly load:(device:SessionDirectoryDevice)=>Promise<SessionDirectoryLoad>,readonly changed:()=>void,readonly now:()=>number=Date.now,cached:readonly SessionDirectorySnapshot[]=[]) {
    for(const snapshot of cached.slice(0,SESSION_DIRECTORY_MAX_DEVICES))this.#snapshots.set(sessionDirectoryDeviceKey(snapshot.device),{...snapshot,loading:false});
  }
  snapshots():SessionDirectorySnapshot[]{return [...this.#snapshots.values()];}
  snapshot(key:string):SessionDirectorySnapshot|undefined{return this.#snapshots.get(key);}
  configure(devices:readonly SessionDirectoryDevice[]):void{
    if(this.#disposed)return;
    const next=new Map<string,Scope>();
    for(const device of devices.slice(0,SESSION_DIRECTORY_MAX_DEVICES)){
      const key=sessionDirectoryDeviceKey(device);
      if(next.has(key))continue;
      const previous=this.#scopes.get(key);
      const sameOwner=previous?.device.deviceId===device.deviceId&&previous?.device.local===device.local;
      next.set(key,{device,token:sameOwner?previous!.token:Symbol(key)});
    }
    for(const [key] of this.#snapshots)if(!next.has(key)){
      this.#snapshots.delete(key);
    }
    this.#queue=this.#queue.filter(job=>{
      if(next.get(job.key)?.token===job.scope.token)return true;
      if(this.#flights.get(job.key)===job)this.#flights.delete(job.key);
      job.resolve(null);return false;
    });
    this.#scopes=next;
    for(const [key,scope] of next){
      const previous=this.#snapshots.get(key);
      const sameOwner=previous?.device.deviceId===scope.device.deviceId&&previous?.device.local===scope.device.local;
      this.#snapshots.set(key,sameOwner?{...previous!,device:scope.device}:{device:scope.device,projects:[],sessions:[],loading:false,error:'',observedAt:null});
    }
    this.changed();
  }
  refresh():Promise<(SessionDirectorySnapshot|null)[]>{return Promise.all([...this.#scopes.keys()].map(key=>this.refreshDevice(key)));}
  refreshDevice(key:string):Promise<SessionDirectorySnapshot|null>{
    const scope=this.#scopes.get(key);
    if(this.#disposed||!scope)return Promise.resolve(null);
    const prior=this.#flights.get(key);
    if(prior?.scope.token===scope.token)return prior.promise;
    let resolve!:(value:SessionDirectorySnapshot|null)=>void;
    const promise=new Promise<SessionDirectorySnapshot|null>(done=>{resolve=done;});
    const job:Job={key,scope,promise,resolve};
    this.#flights.set(key,job);this.#queue.push(job);
    const snapshot=this.#snapshots.get(key)!;
    this.#snapshots.set(key,{...snapshot,loading:true});this.changed();this.#drain();
    return promise;
  }
  #drain():void{
    while(!this.#disposed&&this.#running<SESSION_DIRECTORY_CONCURRENCY&&this.#queue.length){
      const job=this.#queue.shift()!;
      if(this.#scopes.get(job.key)?.token!==job.scope.token){job.resolve(null);continue;}
      this.#running++;
      void Promise.resolve().then(()=>this.load(job.scope.device)).then(value=>{
        if(this.#disposed||this.#scopes.get(job.key)?.token!==job.scope.token)return null;
        const snapshot:SessionDirectorySnapshot={...value,sessions:value.sessions.slice(0,24),device:this.#scopes.get(job.key)!.device,loading:false,error:'',observedAt:this.now()};
        this.#snapshots.set(job.key,snapshot);this.changed();return snapshot;
      },error=>{
        if(this.#disposed||this.#scopes.get(job.key)?.token!==job.scope.token)return null;
        const prior=this.#snapshots.get(job.key)!;
        const snapshot={...prior,loading:false,error:error instanceof Error?error.message:String(error)};
        this.#snapshots.set(job.key,snapshot);this.changed();return snapshot;
      }).then(job.resolve).finally(()=>{
        this.#running--;if(this.#flights.get(job.key)===job)this.#flights.delete(job.key);this.#drain();
      });
    }
  }
  dispose():void{
    this.#disposed=true;for(const job of this.#queue)job.resolve(null);
    this.#queue=[];this.#scopes.clear();this.#snapshots.clear();this.#flights.clear();
  }
}

export interface SessionDirectoryRow {key:string;session:AiTerminalSummary;label:string;projectLabel:string;targetLabel:string}
export interface SessionDirectoryGroup {key:string;projectId:string;label:string;rows:SessionDirectoryRow[];projects:WorkroomMentionProject[]}
const normalized=(value:string)=>value.normalize('NFKC').toLocaleLowerCase().trim();

/** Groups never cross a device boundary, even when project names or session ids coincide. */
export function sessionDirectoryGroups(snapshot:SessionDirectorySnapshot,query='',showEnded=false,includeEmpty=false):SessionDirectoryGroup[]{
  const groups=new Map<string,SessionDirectoryGroup>();
  const byTarget=new Map(snapshot.projects.map(project=>[project.targetId,project]));
  const labels=workroomSessionLabels(snapshot.sessions,targetId=>byTarget.get(targetId)?.label);
  const needle=normalized(query);
  for(const project of snapshot.projects){
    const projectId=project.projectTargetId??project.targetId;
    let group=groups.get(projectId);
    if(!group){group={key:`${sessionDirectoryDeviceKey(snapshot.device)}:${projectId}`,projectId,label:byTarget.get(projectId)?.label??project.label,rows:[],projects:[]};groups.set(projectId,group);}
    group.projects.push(project);
  }
  for(const session of snapshot.sessions){
    if(!showEnded&&session.state==='exited')continue;
    const target=byTarget.get(session.targetId),projectId=target?.projectTargetId??session.targetId;
    let group=groups.get(projectId);
    if(!group){group={key:`${sessionDirectoryDeviceKey(snapshot.device)}:${projectId}`,projectId,label:target?.label??'프로젝트 연결 확인 필요',rows:[],projects:[]};groups.set(projectId,group);}
    const label=labels.get(session.id)??session.agent;
    const targetLabel=target?.label??'프로젝트 연결 확인 필요';
    const text=normalized([snapshot.device.label,group.label,targetLabel,label,session.accountLabel??'',session.id].join(' '));
    if(needle&&!text.includes(needle))continue;
    group.rows.push({key:sessionDirectoryRowKey(snapshot.device,session.id),session,label,projectLabel:group.label,targetLabel});
  }
  return [...groups.values()].filter(group=>group.rows.length||(includeEmpty&&(!needle||normalized(`${snapshot.device.label} ${group.label} ${group.projects.map(project=>project.label).join(' ')}`).includes(needle))))
    .map(group=>({...group,rows:group.rows.sort((a,b)=>Date.parse(b.session.createdAt)-Date.parse(a.session.createdAt)||a.session.id.localeCompare(b.session.id))}))
    .sort((a,b)=>(Date.parse(b.rows[0]?.session.createdAt??'')||0)-(Date.parse(a.rows[0]?.session.createdAt??'')||0)||a.label.localeCompare(b.label));
}

export interface SessionDirectoryLiveRow {
  key:string;session:AiTerminalSummary;label:string;targetLabel:string;
  presentation:WorkroomActivityPresentation;activity?:WorkroomActivityView;
}
export interface SessionDirectoryLiveGroup {id:WorkroomActivityGroup;title:string;rows:SessionDirectoryLiveRow[]}

/**
 * Live sessions first, grouped by who needs the person: 응답 필요 → 작업 중 → 완료 → 응답 멈춤 → 대기 → 실행 중 → 종료.
 * Activity exists only for this Mac's sessions (the host's own state); another Mac's rows read 「실행 중」/「종료」. Each
 * heading is true of its rows (workroomActivityView.ts). Exited rows stay until the host prunes them (it keeps 24 sessions
 * and retires the oldest exited ones).
 */
export function sessionDirectoryLiveGroups(snapshot:SessionDirectorySnapshot,query='',activity?:ReadonlyMap<string,WorkroomActivityView>):SessionDirectoryLiveGroup[]{
  const byTarget=new Map(snapshot.projects.map(project=>[project.targetId,project]));
  const labels=workroomSessionLabels(snapshot.sessions,targetId=>byTarget.get(targetId)?.label);
  const needle=normalized(query);
  const groups=new Map(WORKROOM_ACTIVITY_GROUPS.map(group=>[group.id,{id:group.id,title:group.title,rows:[] as SessionDirectoryLiveRow[]}]));
  for(const session of snapshot.sessions){
    const target=byTarget.get(session.targetId);
    const targetLabel=target?.label??'프로젝트 연결 확인 필요';
    const label=labels.get(session.id)??session.agent;
    const own=snapshot.device.local?activity?.get(session.id):undefined;
    const matched=own&&own.targetId===session.targetId&&own.agent===session.agent?own:undefined;
    const presentation=workroomActivityPresentation(session.state,matched);
    const text=normalized([snapshot.device.label,targetLabel,label,presentation.label,session.accountLabel??'',session.id].join(' '));
    if(needle&&!text.includes(needle))continue;
    groups.get(presentation.group)!.rows.push({key:sessionDirectoryRowKey(snapshot.device,session.id),session,label,targetLabel,presentation,...(matched?{activity:matched}:{})});
  }
  const recent=(row:SessionDirectoryLiveRow)=>row.activity?.since??Date.parse(row.session.createdAt);
  return [...groups.values()].filter(group=>group.rows.length)
    .map(group=>({...group,rows:group.rows.sort((a,b)=>(recent(b)-recent(a))||a.session.id.localeCompare(b.session.id))}));
}

/** Projects to start a new conversation in (main checkouts and worktrees), filtered by the search. */
export function sessionDirectoryStartProjects(snapshot:SessionDirectorySnapshot,query=''):WorkroomMentionProject[]{
  const needle=normalized(query);
  return snapshot.projects.filter(project=>!needle||normalized(`${snapshot.device.label} ${project.label}`).includes(needle));
}
