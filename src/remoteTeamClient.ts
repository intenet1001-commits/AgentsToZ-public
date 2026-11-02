import {createHash,randomUUID} from 'node:crypto';
import type {RemoteTeamStore} from './remoteTeamHost';
import {parseRemoteTeamMember,parseRemoteTeamRef,parseRemoteTeamTarget,parseRemoteTeamResponse,remoteTeamObject,remoteTeamExact,type RemoteTeamRef,type RemoteTeamRequest,type RemoteTeamResponse,type RemoteTeamStatus} from './remoteTeamProtocol';
import type {TeamRemoteRuntime,TeamRemoteObserved} from './workroomTeam';
interface Transport {
  controlCall(endpoint:string,request:Record<string,unknown>,timeout:number,options:{transportPurpose:'teams';sourceEndpointId?:string;onSent?:(sent:{controlId:string;sourceEndpointId:string;targetDeviceId:string|null})=>void}):Promise<Record<string,unknown>>;
  controlResult(ids:readonly string[],source:string):Promise<{results:{controlId:string;response:Record<string,unknown>|null}[];waiting:string[]}>;
}
type Proxy={id:string;generation:string;device:string;endpoint:string;project:string;createId:string;receiver:string|null};
type Call={id:string;fingerprint:string;control:string|null;source:string|null;response:string|null};
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const opid=(v:unknown)=>`remote-${hash(v).slice(0,56)}`;
/** Sender proxy: local opaque handles bind to receiver-issued references, never a source checkout path. */
export class RemoteTeamClient implements TeamRemoteRuntime {
  #chain:Promise<unknown>=Promise.resolve();
  constructor(readonly store:RemoteTeamStore,readonly transport:Transport){store.db.exec('CREATE TABLE IF NOT EXISTS client_refs(id TEXT PRIMARY KEY,generation TEXT NOT NULL,device TEXT NOT NULL,endpoint TEXT NOT NULL,project TEXT NOT NULL,createId TEXT NOT NULL UNIQUE,receiver TEXT); CREATE TABLE IF NOT EXISTS client_calls(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,control TEXT,source TEXT,response TEXT);');}
  #serial<T>(work:()=>Promise<T>):Promise<T>{const p=this.#chain.catch(()=>{}).then(work);this.#chain=p;return p;}
  #wire(p:Proxy):RemoteTeamRef{return{kind:'remote',remoteRef:p.id,generation:p.generation,deviceId:p.device,endpointId:p.endpoint,projectId:p.project};}
  #proxy(ref:RemoteTeamRef):Proxy{const r=parseRemoteTeamRef(ref),p=this.store.db.query('SELECT * FROM client_refs WHERE id=?').get(r.remoteRef) as Proxy|null;if(!p||p.device!==r.deviceId||p.endpoint!==r.endpointId||p.project!==r.projectId||p.generation!==r.generation)throw Error('원격 Teams proxy 결속을 확인하지 못했습니다.');return p;}
  #body(response:Record<string,unknown>):RemoteTeamResponse{
    if(response.ok!==true)throw Error('상대 Mac의 원격 Teams 응답을 확인하지 못했습니다.');
    const body=remoteTeamObject(response.body);remoteTeamExact(body,['result']);return parseRemoteTeamResponse(body.result);
  }
  async #collect(call:Call):Promise<RemoteTeamResponse|null>{
    if(call.response)return JSON.parse(call.response) as RemoteTeamResponse;
    if(!call.control||!call.source)return null;
    try{const read=await this.transport.controlResult([call.control],call.source),answer=read.results.find(row=>row.controlId===call.control)?.response;
      if(answer){const result=this.#body(answer);this.store.db.query('UPDATE client_calls SET response=? WHERE id=?').run(JSON.stringify(result),call.id);return result;}
    }catch{}return null;
  }
  async #call(p:Proxy,request:RemoteTeamRequest,id:string):Promise<RemoteTeamResponse|null>{
    const fingerprint=hash([p.device,p.endpoint,p.project,request]),existing=this.store.db.query('SELECT * FROM client_calls WHERE id=?').get(id) as Call|null;
    if(existing){if(existing.fingerprint!==fingerprint)throw Error('같은 원격 Teams 요청 ID의 내용이 바뀌었습니다.');return this.#collect(existing);}
    if((this.store.db.query('SELECT count(*) AS n FROM client_calls').get() as {n:number}).n>=4096)throw Error('원격 Teams 영수증 한도에 도달했습니다.');
    // Durable before transport admission: any failure, including before onSent, stays unknown and is never resent.
    this.store.db.query('INSERT INTO client_calls(id,fingerprint) VALUES(?,?)').run(id,fingerprint);
    try{
      let wrongTarget=false;
      const response=await this.transport.controlCall(p.endpoint,request as unknown as Record<string,unknown>,50_000,{transportPurpose:'teams',onSent:sent=>{
        wrongTarget=sent.targetDeviceId!==p.device;
        this.store.db.query('UPDATE client_calls SET control=?,source=? WHERE id=?').run(sent.controlId,sent.sourceEndpointId,id);
      }});
      if(wrongTarget)throw Error('선택한 Mac과 실제 수신 기기가 다릅니다.');
      const result=this.#body(response);this.store.db.query('UPDATE client_calls SET response=? WHERE id=?').run(JSON.stringify(result),id);return result;
    }catch{return null;}
  }
  #bind(p:Proxy,result:RemoteTeamResponse|null):RemoteTeamStatus|null{
    const receiver=result?.outcome==='settled'?result.status.ref:result?.outcome==='unknown'?result.ref:undefined;
    if(receiver){const r=parseRemoteTeamRef(receiver);if(r.deviceId!==p.device||r.endpointId!==p.endpoint||r.projectId!==p.project)throw Error('상대 Mac의 실행 결속이 바뀌었습니다.');
      if(p.receiver&&p.receiver!==JSON.stringify(r))throw Error('상대 Mac의 실행 세대가 바뀌었습니다.');
      p.receiver=JSON.stringify(r);this.store.db.query('UPDATE client_refs SET receiver=? WHERE id=?').run(p.receiver,p.id);
    }
    return result?.outcome==='settled'?result.status:null;
  }
  async projects(target:Parameters<TeamRemoteRuntime['projects']>[0]){
    const t=parseRemoteTeamTarget({...target,projectId:'discovery'}),response=this.#body(await this.transport.controlCall(t.endpointId,{kind:'team',version:1,targetDeviceId:t.deviceId,op:'projects'},10_000,{transportPurpose:'teams'}));
    if(response.outcome!=='projects'||!Array.isArray(response.projects)||response.projects.length>200)throw Error('상대 Mac의 허용 프로젝트 목록을 확인하지 못했습니다.');
    return response.projects.map(p=>{parseRemoteTeamTarget({...target,projectId:p.projectId});if(typeof p.name!=='string'||new TextEncoder().encode(p.name).length>240)throw Error('프로젝트 표시 이름을 확인하지 못했습니다.');return{projectId:p.projectId,name:p.name};});
  }
  async #resolve(p:Proxy):Promise<RemoteTeamStatus|null>{
    const create=this.store.db.query('SELECT * FROM client_calls WHERE id=?').get(p.createId) as Call|null;
    if(!p.receiver&&create){let result=await this.#collect(create);if(!result){try{result=this.#body(await this.transport.controlCall(p.endpoint,{kind:'team',version:1,targetDeviceId:p.device,op:'receipt',requestId:p.createId},10_000,{transportPurpose:'teams',...(create.source?{sourceEndpointId:create.source}:{})}));}catch{}}
      const resolved=this.#bind(p,result);if(resolved)return resolved;}
    if(!p.receiver)return null;
    try{return this.#bind(p,this.#body(await this.transport.controlCall(p.endpoint,{kind:'team',version:1,targetDeviceId:p.device,op:'status',ref:JSON.parse(p.receiver)},10_000,{transportPurpose:'teams',...(create?.source?{sourceEndpointId:create.source}:{})})));}catch{return null;}
  }
  async start(input:Parameters<TeamRemoteRuntime['start']>[0]){return this.#serial(async()=>{
    const target=parseRemoteTeamTarget(input.target),member=parseRemoteTeamMember(Object.fromEntries(Object.entries(input.member).filter(([k])=>['agent','task','name','model','provider','effort','role'].includes(k))));
    const id=opid(['create',input.requestId,target]);let p=this.store.db.query('SELECT * FROM client_refs WHERE createId=?').get(id) as Proxy|null;
      if(!p){
        if((this.store.db.query('SELECT count(*) AS n FROM client_refs').get() as {n:number}).n>=4096||(this.store.db.query('SELECT count(*) AS n FROM client_calls').get() as {n:number}).n>=4096)throw Error('원격 Teams 영수증 한도에 도달했습니다.');
        p={id:randomUUID(),generation:randomUUID(),device:target.deviceId,endpoint:target.endpointId,project:target.projectId,createId:id,receiver:null};this.store.db.query('INSERT INTO client_refs VALUES(?,?,?,?,?,?,NULL)').run(p.id,p.generation,p.device,p.endpoint,p.project,p.createId);
      }
    const result=await this.#call(p,{kind:'team',version:1,targetDeviceId:p.device,op:'create',requestId:id,projectId:target.projectId,title:input.title,goal:input.goal,member},id),status=this.#bind(p,result);
    return{ref:this.#wire(p),state:status?.state??'unknown' as const,delivery:status?.delivery??'unknown' as const,note:'상대 Mac의 허용 프로젝트에서 실행합니다. 작업 폴더·브랜치는 상대 Mac에 보존됩니다.'};
  });}
  async observe(ref:RemoteTeamRef):Promise<TeamRemoteObserved>{return this.#serial(async()=>{const p=this.#proxy(ref),status=await this.#resolve(p);return{state:status?.state??'unknown',delivery:status?.delivery??'unknown',...(status?.report?{report:status.report}:{})};});}
  async send(ref:RemoteTeamRef,text:string,requestId:string){return this.#serial(async()=>{const p=this.#proxy(ref);await this.#resolve(p);if(!p.receiver)return{delivery:'unknown' as const};const id=opid(['instruct',p.id,requestId]),result=await this.#call(p,{kind:'team',version:1,targetDeviceId:p.device,op:'instruct',requestId:id,ref:JSON.parse(p.receiver),text},id);return{delivery:result?.outcome==='instructed'?result.delivery:'unknown' as const};});}
  async close(ref:RemoteTeamRef){return this.#serial(async()=>{const p=this.#proxy(ref);await this.#resolve(p);if(!p.receiver)return{closed:'unknown' as const};const id=opid(['cancel',p.id]),result=await this.#call(p,{kind:'team',version:1,targetDeviceId:p.device,op:'cancel',requestId:id,ref:JSON.parse(p.receiver)},id);return{closed:result?.outcome==='cancelled'?result.closed:'unknown' as const};});}
}
