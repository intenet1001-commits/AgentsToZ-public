import {DurableObject} from 'cloudflare:workers';
import {CommunityRegistry} from './registry';
import {DurableRegistryStore} from './store';
import {privateKey,keyString,hash} from './protocol';
import {createPublicKey} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {CommunityAccessRegistry} from './accessRegistry';
export {CommunityRelayHub} from './relayHub';
import {createApnsSender,isDeadToken} from '../../../supabase/functions/screen-push/protocol';

interface Environment {REGISTRY:DurableObjectNamespace;RELAY:DurableObjectNamespace;COMMUNITY_ISSUER_JWK:string;COMMUNITY_STATE_KEY:string;
  COMMUNITY_BOOTSTRAP_HOST?:string;COMMUNITY_BOOTSTRAP_VIEWER?:string;COMMUNITY_BOOTSTRAP_PROFILE?:string;
  APNS_KEY_P8?:string;APNS_KEY_ID?:string;APNS_TEAM_ID?:string;APNS_TOPICS?:string}

export class ScreenCommunityRegistry extends DurableObject<Environment> {
  async fetch(request:Request):Promise<Response>{
    try{
      if(!this.env.COMMUNITY_ISSUER_JWK||!this.env.COMMUNITY_STATE_KEY)return Response.json({error:'NOT_CONFIGURED'},{status:503});
      const issuer=privateKey(this.env.COMMUNITY_ISSUER_JWK),key=keyString(createPublicKey(issuer));
      const url=new URL(request.url);
      if(request.method==='GET'&&url.pathname==='/health'&&!url.search)return Response.json({protocol:1,issuerKey:key,issuerFingerprint:hash(Buffer.from(key,'base64url'))});
      if(request.method!=='POST'||!['/v1','/v2','/internal/relay-admission'].includes(url.pathname)||url.search||request.headers.get('content-type')!=='application/json')return Response.json({error:'INVALID_REQUEST'},{status:400});
      const reader=request.body?.getReader();if(!reader)return Response.json({error:'INVALID_REQUEST'},{status:400});
      const chunks:Uint8Array[]=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32_768){await reader.cancel();return Response.json({error:'REQUEST_TOO_LARGE'},{status:413});}chunks.push(value);}
      const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      const store=new DurableRegistryStore(this.ctx.storage as never);
      if(url.pathname!=='/v1'){
        const access=new CommunityAccessRegistry(store,issuer,key,Buffer.from(this.env.COMMUNITY_STATE_KEY,'base64url'));
        if(url.pathname==='/internal/relay-admission'){
          try{return Response.json(access.admitTicket(JSON.parse(text)),{headers:{'Cache-Control':'no-store'}});}
          catch{return Response.json({error:'TICKET_REFUSED'},{status:403,headers:{'Cache-Control':'no-store'}});}
        }
        const result=access.handle(JSON.parse(text),request.headers.get('CF-Connecting-IP')??'unknown');
        return Response.json(result.envelope,{status:result.status,headers:{'Cache-Control':'no-store'}});
      }
      const topics=(this.env.APNS_TOPICS??'').split(',').map(s=>s.trim()).filter(s=>/^[A-Za-z0-9.-]{1,120}$/.test(s));
      const service=new CommunityRegistry(store,issuer,Buffer.from(this.env.COMMUNITY_STATE_KEY,'base64url'),Date.now,
        (host,viewer,profile)=>host===this.env.COMMUNITY_BOOTSTRAP_HOST&&viewer===this.env.COMMUNITY_BOOTSTRAP_VIEWER&&profile===this.env.COMMUNITY_BOOTSTRAP_PROFILE,topics);
      const result=service.handle(JSON.parse(text),request.headers.get('CF-Connecting-IP')??'unknown');
      // Notification delivery is advisory, after membership/request commit. A push carries no approval capability.
      if(this.env.APNS_KEY_P8&&this.env.APNS_KEY_ID&&this.env.APNS_TEAM_ID&&topics.length){
        // workerd's global fetch is receiver-bound. Passing it as options.fetch changes `this` and fails before I/O.
        const sender=createApnsSender({keyP8:this.env.APNS_KEY_P8,keyID:this.env.APNS_KEY_ID,teamID:this.env.APNS_TEAM_ID,fetch:(input,init)=>fetch(input,init)});
        this.ctx.waitUntil(Promise.all(service.takeNotifications().map(async job=>{
          try{
            const payload=JSON.stringify({aps:{alert:{title:'AgentsToZ 커뮤니티',body:'새 기기가 원격 접근 등록을 요청했습니다. 앱에서 확인해 주세요.'},
              sound:'default','thread-id':'community-enrollment'},communityEnrollment:job.notice});
            const answer=await sender.send({deviceID:job.recipientId,token:job.token,environment:job.environment,topic:job.topic},payload,job.expiresAt,job.pendingId);
            if(isDeadToken(answer))store.transaction(()=>store.remove(`push:${job.recipientId}`));
          }catch{/* Failed delivery never approves or replays a registration; the in-app pending list remains available. */}
        })));
      }
      return Response.json(result.envelope,{status:result.status,headers:{'Cache-Control':'no-store'}});
    }catch{return Response.json({error:'SERVICE_UNAVAILABLE'},{status:503});}
  }
}

export default {
  async fetch(request:Request,env:Environment):Promise<Response>{
    const url=new URL(request.url);
    if(url.pathname==='/relay'){
      if(url.search||!env.RELAY)return new Response('Not configured',{status:503});
      // One room namespace for an opaque routing service; peer community is issuer-authenticated, never a query value.
      return env.RELAY.get(env.RELAY.idFromName('community-access-relay-v2')).fetch(request);
    }
    if(url.pathname!=='/v1'&&url.pathname!=='/v2'&&url.pathname!=='/health')return new Response('Not found',{status:404});
    return env.REGISTRY.get(env.REGISTRY.idFromName('screen-community-registry-v1')).fetch(request);
  },
};
