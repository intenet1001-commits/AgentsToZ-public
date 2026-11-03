import {DurableObject} from 'cloudflare:workers';
import {CommunityRegistry} from './registry';
import {DurableRegistryStore} from './store';
import {privateKey,keyString,hash,readRequest} from './protocol';
import {readAccessRequest} from './accessProtocol';
import {createPublicKey} from 'node:crypto';
import {Buffer} from 'node:buffer';
import type {CommunityNotification} from './registry';
import type {CommunityAccessNotification} from './accessRegistry';
import type {SafetyNotification} from './screenSafety';
import {CommunityAccessRegistry} from './accessRegistry';
export {CommunityRelayHub} from './relayHub';
import {createApnsSender,isDeadToken} from '../../../supabase/functions/screen-push/protocol';
interface Environment {REGISTRY:DurableObjectNamespace;RELAY:DurableObjectNamespace;COMMUNITY_ISSUER_JWK:string;COMMUNITY_STATE_KEY:string;
  COMMUNITY_BOOTSTRAP_HOST?:string;COMMUNITY_BOOTSTRAP_VIEWER?:string;COMMUNITY_BOOTSTRAP_PROFILE?:string;
  APNS_KEY_P8?:string;APNS_KEY_ID?:string;APNS_TEAM_ID?:string;APNS_TOPICS?:string}

export class ScreenCommunityRegistry extends DurableObject<Environment> {
  private notificationDelivery:Promise<void>|undefined;
  private services(){
    const issuer=privateKey(this.env.COMMUNITY_ISSUER_JWK),key=keyString(createPublicKey(issuer));
    const store=new DurableRegistryStore(this.ctx.storage as never),state=Buffer.from(this.env.COMMUNITY_STATE_KEY,'base64url');
    const topics=(this.env.APNS_TOPICS??'').split(',').map(s=>s.trim()).filter(s=>/^[A-Za-z0-9.-]{1,120}$/.test(s));
    return {store,topics,access:new CommunityAccessRegistry(store,issuer,key,state,Date.now,topics,this.configuredPush()),
      legacy:new CommunityRegistry(store,issuer,state,Date.now,(host,viewer,profile)=>host===this.env.COMMUNITY_BOOTSTRAP_HOST&&viewer===this.env.COMMUNITY_BOOTSTRAP_VIEWER&&profile===this.env.COMMUNITY_BOOTSTRAP_PROFILE,topics)};
  }
  private configuredPush():boolean {return !!(this.env.APNS_KEY_P8&&this.env.APNS_KEY_ID&&this.env.APNS_TEAM_ID&&(this.env.APNS_TOPICS??'').split(',').some(t=>/^[A-Za-z0-9.-]{1,120}$/.test(t.trim())));}
  private async armNotifications():Promise<void>{
    const at=Date.now()+1_000,current=await this.ctx.storage.getAlarm();if(current===null||current>at)await this.ctx.storage.setAlarm(at);
  }
  private drainNotifications():Promise<void>{
    if(this.notificationDelivery)return this.notificationDelivery;
    const task=this.deliverNotificationBatch().finally(()=>{if(this.notificationDelivery===task)this.notificationDelivery=undefined;});
    this.notificationDelivery=task;return task;
  }
  /** A durable continuation drains only remaining advisory jobs, never prepare/approve mutations. */
  async alarm():Promise<void>{await this.drainNotifications();}
  private async deliverNotificationBatch():Promise<void>{
    if(!this.configuredPush())return;
    const {store,access,legacy}=this.services();if(!access.hasNotifications()&&!legacy.hasNotifications()&&!access.screenSafety().hasNotifications())return;
    await this.armNotifications();
    type Job={version:1;job:CommunityNotification}|{version:2;job:CommunityAccessNotification}|{version:3;job:SafetyNotification};
    const jobs:Job[]=[],turn=(store.get<number>('notification-turn')??0)%3;
    for(let i=0;i<3&&jobs.length<4;i++){
      const source=(turn+i)%3,left=4-jobs.length;
      if(source===0)jobs.push(...access.takeNotifications(left).map(job=>({version:2 as const,job})));
      if(source===1)jobs.push(...legacy.takeNotifications(left).map(job=>({version:1 as const,job})));
      if(source===2)jobs.push(...access.screenSafety().takeNotifications(left).map(job=>({version:3 as const,job})));
    }
    store.put('notification-turn',(turn+1)%3);
    if(!jobs.length)return;
    const sender=createApnsSender({keyP8:this.env.APNS_KEY_P8!,keyID:this.env.APNS_KEY_ID!,teamID:this.env.APNS_TEAM_ID!,fetch:(input,init)=>fetch(input,init)});
    try{
      await Promise.all(jobs.map(async item=>{
        try{
          const current=item.version===3?access.screenSafety().notificationCurrent(item.job):item.version===2?access.notificationCurrent(item.job):legacy.notificationCurrent(item.job);if(!current)return;
          const text=item.version===3?({connection:'등록된 Mac에 화면 연결을 시도했습니다.',enrollment:'Mac의 화면 수신 등록이 갱신됐습니다.',security:'등록된 Mac에서 보안 사건을 알렸습니다.'}[item.job.eventKind]):item.version===2?'새 기기가 기능 등록을 요청했습니다. 앱에서 확인해 주세요.':'새 기기가 원격 접근 등록을 요청했습니다. 앱에서 확인해 주세요.';
          const payload=JSON.stringify({aps:{alert:{title:'AgentsToZ 커뮤니티',body:text},sound:'default','thread-id':item.version===3?'community-screen-safety':item.version===2?'community-access-enrollment':'community-enrollment'},...(item.version===3?{communityScreenSafety:item.job.notice}:{communityEnrollment:item.job.notice})});
          const id=item.version===3?item.job.eventId:item.version===2?item.job.planId:item.job.pendingId;
          const answer=await sender.send({deviceID:item.job.recipientId,token:item.job.token,environment:item.job.environment,topic:item.job.topic},payload,item.job.expiresAt,id);
          if(isDeadToken(answer)){if(item.version===3)access.screenSafety().removeDeadPush(item.job);else if(item.version===2)access.removeDeadPush(item.job);else legacy.removeDeadPush(item.job);}
        }catch{/* An advisory failure cannot change approval results or retry a mutation. */}
      }));
    }finally{
      // Keep the earliest existing deadline and re-arm only for unclaimed, still-eligible jobs.
      // Any new prepare/subscription is durably pre-armed before commit; an empty alarm never loops.
      if(access.hasNotifications()||legacy.hasNotifications()||access.screenSafety().hasNotifications())await this.armNotifications();
    }
  }
  async fetch(request:Request):Promise<Response>{
    try{
      if(!this.env.COMMUNITY_ISSUER_JWK||!this.env.COMMUNITY_STATE_KEY)return Response.json({error:'NOT_CONFIGURED'},{status:503});
      const issuer=privateKey(this.env.COMMUNITY_ISSUER_JWK),key=keyString(createPublicKey(issuer)),url=new URL(request.url);
      if(request.method==='GET'&&url.pathname==='/health'&&!url.search)return Response.json({protocol:1,issuerKey:key,issuerFingerprint:hash(Buffer.from(key,'base64url'))});
      if(request.method!=='POST'||!['/v1','/v2','/internal/relay-admission'].includes(url.pathname)||url.search||request.headers.get('content-type')!=='application/json')return Response.json({error:'INVALID_REQUEST'},{status:400});
      const reader=request.body?.getReader();if(!reader)return Response.json({error:'INVALID_REQUEST'},{status:400});
      const chunks:Uint8Array[]=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32_768){await reader.cancel();return Response.json({error:'REQUEST_TOO_LARGE'},{status:413});}chunks.push(value);}
      const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))),{access,legacy}=this.services();
      if(url.pathname==='/internal/relay-admission'){
        try{return Response.json(access.admitTicket(body),{headers:{'Cache-Control':'no-store'}});}catch{return Response.json({error:'TICKET_REFUSED'},{status:403,headers:{'Cache-Control':'no-store'}});}
      }
      // Pre-arm before a transaction can create pending work or make a subscription eligible. Parsing grants nothing.
      let canEnqueue=false;
      try{canEnqueue=url.pathname==='/v2'?['prepare','screen-safety-subscribe','receiver-safety-event'].includes(readAccessRequest(body,Date.now()).op):['entry','join','push-register'].includes(readRequest(body,Date.now()).op);}catch{}
      if(canEnqueue&&this.configuredPush())await this.armNotifications();
      const result=url.pathname==='/v2'?access.handle(body,request.headers.get('CF-Connecting-IP')??'unknown'):legacy.handle(body,request.headers.get('CF-Connecting-IP')??'unknown');
      if(result.status===200&&this.configuredPush())this.ctx.waitUntil(this.drainNotifications());
      return Response.json(result.envelope,{status:result.status,headers:{'Cache-Control':'no-store'}});
    }catch{return Response.json({error:'SERVICE_UNAVAILABLE'},{status:503});}
  }
}
export default {
  async fetch(request:Request,env:Environment):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==='/relay'){
      if(url.search||!env.RELAY)return new Response('Not configured',{status:503});
      return env.RELAY.get(env.RELAY.idFromName('community-access-relay-v2')).fetch(request);
    }
    if(url.pathname!=='/v1'&&url.pathname!=='/v2'&&url.pathname!=='/health')return new Response('Not found',{status:404});
    return env.REGISTRY.get(env.REGISTRY.idFromName('screen-community-registry-v1')).fetch(request);
  },
};
