import {createHash,createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {WorkroomThreadStore,type StoredWorkroomThread} from './workroomThreadStore';
import type {ServiceUseAdapter} from './serviceUseHost';
import {normalizeServiceUseOutcome,type ServiceUseBinding} from './serviceUseProtocol';
import {normalizeAppUseActions,validateAppUseAction,type AppUseAction} from './appUseCatalog';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const scopeFields=['principalId','libraryId','deviceId','installationId','grantRevision'] as const;
type Scope=Pick<ServiceUseBinding,typeof scopeFields[number]>;
type Code={port:number;installationId:string;grantId:string;secret:string};
type Snapshot={projectId:string;serviceKey:string;definitionRevision:string;scope:Scope;actions:AppUseAction[]};
function parseCode(code:string):Code {
  const match=/^ATZUSE1\.([A-Za-z0-9_-]{1,600})\.([A-Za-z0-9_-]{43})$/.exec(code);
  const fail=():never=>{throw Error('앱에서 발급한 USE 연결 코드를 확인하세요.');};
  if(!match)return fail();
  let data:any;try{data=JSON.parse(Buffer.from(match[1]!,'base64url').toString('utf8'));}catch{return fail();}
  if(!data||Object.keys(data).sort().join(',')!=='grantId,installationId,port'||!Number.isSafeInteger(data.port)||data.port<1024||data.port>65535||data.port===3001
    ||![data.installationId,data.grantId].every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(v)))return fail();
  return {...data,secret:match[2]!};
}
/** One installed connector, any explicitly connected app. Never loads project code or arbitrary URLs. */
export class AppUseConnector {
  private vault?:WorkroomThreadStore;
  private root:string;
  constructor(appDataDir:string,private deps:{vault?:WorkroomThreadStore;fetch?:typeof fetch}={}){this.root=join(appDataDir,'app-use-connections');this.vault=deps.vault;}
  private storage(){return this.vault??=new WorkroomThreadStore(this.root);}
  private id(projectId:string,serviceKey:string){return 'appuse_'+hash(JSON.stringify([projectId,serviceKey]));}
  private async post(code:string,operation:'scope'|'execute'|'receipt',body:unknown,active:()=>boolean){
    const parsed=parseCode(code);if(!active())throw Error('USE 연결 권한이 변경되었습니다.');
    const key=Buffer.from(hash(parsed.secret),'hex'),text=JSON.stringify(body),nonce=randomUUID(),stamp=String(Date.now());
    try{
      let response:Response;
      try{response=await (this.deps.fetch??fetch)(`http://127.0.0.1:${parsed.port}/api/agentstoz-use/${operation}`,{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),body:text,
        headers:{'Content-Type':'application/json','x-agentstoz-use-grant':parsed.installationId+'.'+parsed.grantId,'x-agentstoz-use-time':stamp,'x-agentstoz-use-nonce':nonce,
          'x-agentstoz-use-signature':createHmac('sha256',key).update(`ATZUSE1\n${operation}\n${stamp}\n${nonce}\n${hash(text)}`).digest('hex')},
      });}catch{throw Error('앱의 USE 연결 응답을 확인하지 못했습니다. 앱을 열고 원래 요청 ID로 결과를 확인하세요.');}
      if(!active()||!response.ok||response.headers.has('location'))throw Error('앱의 USE 운영 권한과 원래 요청 ID를 확인하세요.');
      const reader=response.body?.getReader();if(!reader)throw Error('앱 USE 응답이 없습니다.');
      const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>12000)throw Error('bounded');chunks.push(value);}}
      catch{await reader.cancel().catch(()=>{});throw Error('앱 USE 응답의 크기·형식을 확인하세요.');}
      const reply=Buffer.concat(chunks).toString('utf8'),proof=response.headers.get('x-agentstoz-use-proof')??'';
      const expected=createHmac('sha256',key).update(`reply\n${nonce}\n${hash(reply)}`).digest();
      if(!active()||!/^[a-f0-9]{64}$/.test(proof)||!timingSafeEqual(Buffer.from(proof,'hex'),expected))throw Error('앱 USE 응답 서명을 확인하지 못했습니다.');
      try{return JSON.parse(reply);}catch{throw Error('앱 USE 응답 형식을 확인하세요.');}
    }finally{key.fill(0);}
  }
  private async snapshot(code:string,projectId:string,serviceKey:string,active:()=>boolean):Promise<Snapshot>{
    const data=await this.post(code,'scope',{},active),parsed=parseCode(code);
    if(!data||Object.keys(data).sort().join(',')!=='actions,definitionRevision,projectId,protocol,scope,serviceKey'||data.protocol!=='agentstoz-app-use-v1'
      ||data.projectId!==projectId||data.serviceKey!==serviceKey||typeof data.definitionRevision!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(data.definitionRevision)
      ||!data.scope||Object.keys(data.scope).length!==scopeFields.length||scopeFields.some(k=>typeof data.scope[k]!=='string'||!data.scope[k]||data.scope[k].length>256)
      ||data.scope.installationId!==parsed.installationId||data.scope.grantRevision!==parsed.grantId)throw Error('이 프로젝트의 앱 USE 연결 계약을 확인하세요.');
    return {projectId,serviceKey,definitionRevision:data.definitionRevision,scope:Object.fromEntries(scopeFields.map(k=>[k,data.scope[k]])) as Scope,actions:normalizeAppUseActions(data.actions)};
  }
  async connect(projectId:string,serviceKey:string,code:string,consent:boolean){
    if(!consent)throw Error('앱 USE 연결 등록 동의가 필요합니다.');
    const snapshot=await this.snapshot(code,projectId,serviceKey,()=>true),id=this.id(projectId,serviceKey),at=new Date().toISOString();
    await this.storage().mutate(id,()=>true,prior=>{
      const record:StoredWorkroomThread={id,targetId:projectId,owner:'local',fingerprint:hash(JSON.stringify(snapshot)),bootId:'app-use-v1',intentHash:hash(code),
        title:'App USE connection',agent:'codex',sessionId:null,state:'closed',revision:(prior?.revision??0)+1,createdAt:prior?.createdAt??at,updatedAt:at,
        messages:[{id:'capability',seq:1,role:'system',kind:'notice',text:code,at,delivery:'recorded'},{id:'catalog',seq:2,role:'system',kind:'notice',text:JSON.stringify(snapshot),at,delivery:'recorded'}]};
      return {record,value:null};
    });
    return {connected:true};
  }
  async adapter(projectId:string,serviceKey:string):Promise<ServiceUseAdapter|undefined>{
    if(!this.vault&&!existsSync(join(this.root,'workroom-threads.v1.sqlite')))return undefined;
    const record=await this.storage().get(this.id(projectId,serviceKey));if(!record)return undefined;
    const code=record.messages[0]?.text,snapshot=JSON.parse(record.messages[1]?.text??'null') as Snapshot;
    if(record.targetId!==projectId||record.owner!=='local'||typeof code!=='string'||!snapshot||hash(JSON.stringify(snapshot))!==record.fingerprint)throw Error('앱 USE 연결 저장소를 확인하세요.');
    const actions=normalizeAppUseActions(snapshot.actions);
    const current=async(active:()=>boolean)=>{
      const stored=await this.storage().get(record.id);
      if(!active()||stored?.revision!==record.revision||stored.intentHash!==record.intentHash)throw Error('앱 USE 연결이 변경되었습니다.');
      const live=await this.snapshot(code,projectId,serviceKey,active);
      if(hash(JSON.stringify(live))!==record.fingerprint)throw Error('앱의 사용자·자료·동작 권한이 변경되었습니다. USE 연결을 다시 확인하세요.');
      return live;
    };
    const result=async(operation:'execute'|'receipt',body:unknown,active:()=>boolean)=>{
      await current(active);const data=await this.post(code,operation,body,active);await current(active);
      return normalizeServiceUseOutcome(data?.outcome);
    };
    return {projectId,serviceKey,definitionRevision:snapshot.definitionRevision,tools:['app.invoke'],actions,
      scope:async owner=>{if(owner!=='local')throw Error('이 앱 USE 연결은 이 기기의 로컬 사용자 전용입니다.');return (await current(()=>true)).scope;},
      execute:(call,requestId,binding,active)=>{if(call.tool!=='app.invoke')throw Error('앱 USE 동작을 확인하세요.');validateAppUseAction(actions,call.input.actionId!,call.input.arguments);return result('execute',{call,requestId,binding},active);},
      receipt:(requestId,binding,active)=>result('receipt',{requestId,binding},active),
    };
  }
}
