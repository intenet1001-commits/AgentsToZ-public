import {DurableObject} from 'cloudflare:workers';
import {randomBytes,verify} from 'node:crypto';
import {Buffer} from 'node:buffer';
import {publicKey,b64,demand,uuid} from './protocol';
import {exact,type AccessEnvelope,type AccessRelayTicket} from './accessProtocol';

interface Environment {REGISTRY:DurableObjectNamespace}
interface Peer {ticket:AccessRelayTicket;challenge:string|null;deadline:number;windowAt:number;count:number;bytes:number}
const HEADERS={'Cache-Control':'no-store'};
const MAX_CONNECTIONS=128,MAX_CONTROL_BYTES=65_536,MAX_SCREEN_BYTES=262_144;
const proofBytes=(t:AccessRelayTicket,challenge:string)=>Buffer.from(JSON.stringify(['agentstoz.relay.bind/v2',t.ticketId,t.connectionId,challenge]));

/** Ciphertext routing only. A peer's actual authority/keys come from issuer-signed credentials at both endpoints. */
export class CommunityRelayHub extends DurableObject<Environment> {
  private async admit(ticket:unknown):Promise<AccessRelayTicket>{
    const response=await this.env.REGISTRY.get(this.env.REGISTRY.idFromName('screen-community-registry-v1')).fetch(new Request('https://registry.internal/internal/relay-admission',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ticket)}));
    demand(response.ok,'TICKET_REFUSED');return await response.json() as AccessRelayTicket;
  }
  private peers():WebSocket[]{return this.ctx.getWebSockets().filter(ws=>ws.readyState===1);}
  private state(ws:WebSocket):Peer{return ws.deserializeAttachment() as Peer;}
  private schedule():void{
    const deadlines=this.peers().map(ws=>this.state(ws)?.deadline).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n));
    this.ctx.waitUntil(deadlines.length?this.ctx.storage.setAlarm(Math.max(Date.now()+1,Math.min(...deadlines))):this.ctx.storage.deleteAlarm());
  }
  private active(ws:WebSocket):Peer{
    const peer=this.state(ws);demand(peer&&peer.challenge===null&&peer.deadline>Date.now(),'AUTHORIZATION_EXPIRED');return peer;
  }
  async fetch(request:Request):Promise<Response>{
    try{
      const url=new URL(request.url);
      if(url.pathname!=='/relay'||url.search||request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('Not found',{status:404,headers:HEADERS});
      if(this.peers().length>=MAX_CONNECTIONS)return new Response('Busy',{status:429,headers:HEADERS});
      const header=request.headers.get('Authorization');demand(header?.startsWith('AgentsToZ '),'AUTHORIZATION_REQUIRED');
      const parts=header.slice(10).split('.');demand(parts.length===2,'INVALID_TICKET');
      const ticket=await this.admit({payload:parts[0],signature:parts[1]} satisfies AccessEnvelope);
      const pair=new WebSocketPair(),client=pair[0],server=pair[1],now=Date.now();
      const peer:Peer={ticket,challenge:randomBytes(32).toString('base64url'),deadline:Math.min(ticket.expiresAt,now+10_000),windowAt:now,count:0,bytes:0};
      this.ctx.acceptWebSocket(server);server.serializeAttachment(peer);
      server.send(JSON.stringify({type:'challenge',ticketId:ticket.ticketId,connectionId:ticket.connectionId,challenge:peer.challenge}));this.schedule();
      return new Response(null,{status:101,webSocket:client});
    }catch{return new Response('Authorization refused',{status:403,headers:HEADERS});}
  }
  async webSocketMessage(ws:WebSocket,input:string|ArrayBuffer):Promise<void>{
    try{
      demand(typeof input==='string','INVALID_FRAME');const state=this.state(ws),now=Date.now();demand(state&&state.deadline>now,'AUTHORIZATION_EXPIRED');
      const max=state.ticket.purpose==='screen'?MAX_SCREEN_BYTES:MAX_CONTROL_BYTES;demand(Buffer.byteLength(input)<=max,'FRAME_TOO_LARGE');
      const frame=JSON.parse(input);
      if(state.challenge!==null){
        exact(frame,['type','signature']);demand(frame.type==='proof','PROOF_REQUIRED');
        const signature=b64(frame.signature,86);demand(signature.length===64&&verify('sha256',proofBytes(state.ticket,state.challenge),{
          key:publicKey(state.ticket.publicKey).export({format:'pem',type:'spki'}),dsaEncoding:'ieee-p1363'},signature),'INVALID_PROOF');
        // Replacement requires possession of the same bound key; an intercepted ticket cannot evict a peer.
        for(const other of this.peers()){
          if(other===ws)continue;const previous=this.state(other);
          if(previous?.challenge===null&&previous.ticket.communityId===state.ticket.communityId&&previous.ticket.enrollmentId===state.ticket.enrollmentId
            &&previous.ticket.publicKey===state.ticket.publicKey&&previous.ticket.deviceId===state.ticket.deviceId
            &&previous.ticket.purpose===state.ticket.purpose&&previous.ticket.role===state.ticket.role){
            other.close(4001,'Replaced');
          }
        }
        state.challenge=null;state.deadline=state.ticket.leaseExpiresAt;ws.serializeAttachment(state);
        ws.send(JSON.stringify({type:'ready',connectionId:state.ticket.connectionId,leaseExpiresAt:state.deadline}));this.schedule();return;
      }
      if(now-state.windowAt>=1000){state.windowAt=now;state.count=0;state.bytes=0;}
      state.bytes=(state.bytes??0)+Buffer.byteLength(input);
      demand(++state.count<=1024&&state.bytes<=(state.ticket.purpose==='screen'?4*1024*1024:256*1024),'RATE_LIMITED');ws.serializeAttachment(state);
      if(frame?.type==='authorize'){
        exact(frame,['type','ticket']);const next=await this.admit(frame.ticket),old=state.ticket;
        demand(next.communityId===old.communityId&&next.enrollmentId===old.enrollmentId&&next.deviceId===old.deviceId&&next.publicKey===old.publicKey
          &&next.deviceKind===old.deviceKind&&next.connectionId===old.connectionId&&next.purpose===old.purpose&&next.role===old.role
          &&next.sessionId===old.sessionId&&next.revision>=old.revision,'IDENTITY_CHANGED');
        // Awaiting the registry must never revive a connection whose existing lease already ended.
        demand(state.deadline>Date.now()&&next.leaseExpiresAt>Date.now(),'AUTHORIZATION_EXPIRED');
        state.ticket=next;state.deadline=next.leaseExpiresAt;ws.serializeAttachment(state);ws.send(JSON.stringify({type:'authorized',leaseExpiresAt:state.deadline}));this.schedule();return;
      }
      exact(frame,['type','to','id','ciphertext']);demand(frame.type==='data'&&uuid(frame.to)&&uuid(frame.id)&&frame.to!==state.ticket.deviceId,'INVALID_FRAME');
      b64(frame.ciphertext,max);let delivered=false;
      for(const other of this.peers()){
        if(other===ws)continue;let target:Peer;try{target=this.active(other);}catch{continue;}
        if(target.ticket.communityId!==state.ticket.communityId||target.ticket.deviceId!==frame.to||target.ticket.purpose!==state.ticket.purpose)continue;
        if(target.ticket.role===state.ticket.role)continue;
        try{other.send(JSON.stringify({type:'data',from:state.ticket.deviceId,fromConnection:state.ticket.connectionId,id:frame.id,ciphertext:frame.ciphertext}));delivered=true;}
        catch{other.close(1011,'Receiver ended');}
      }
      // This is transport admission, never proof of receipt or execution. The end-to-end protocol owns those.
      ws.send(JSON.stringify({type:'forwarded',id:frame.id,reachable:delivered}));
    }catch{ws.close(4003,'Authorization or frame refused');this.schedule();}
  }
  webSocketClose(ws:WebSocket,code:number):void{
    const ended=this.state(ws);
    if(ended?.challenge===null){
      for(const other of this.peers()){
        const peer=this.state(other);
        if(other===ws||peer?.challenge!==null||peer.ticket.communityId!==ended.ticket.communityId||peer.ticket.purpose!==ended.ticket.purpose)continue;
        try{other.send(JSON.stringify({type:'peer-ended',from:ended.ticket.deviceId,fromConnection:ended.ticket.connectionId}));}catch{/* Peer already ended. */}
      }
    }
    ws.close([1005,1006,1015].includes(code)?1000:code);this.schedule();
  }
  webSocketError(ws:WebSocket):void{ws.close(1011,'Connection ended');this.schedule();}
  async alarm():Promise<void>{for(const ws of this.peers()){const peer=this.state(ws);if(!peer||peer.deadline<=Date.now())ws.close(4003,'Authorization expired');}this.schedule();}
}
