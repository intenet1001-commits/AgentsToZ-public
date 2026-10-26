import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromeUserDataDir} from './browserProfilesServer';
/** `read` marks a command that changes nothing: when it times out it is abandoned (its late reply ignored) instead of
 * closing the connection. Every other command keeps the fail-closed rule — a timed-out mutation is unknown. */
export type CdpSendOptions={read?:{timeoutMs:number}};
export interface BrowserCdp {send(method:string,params?:Record<string,unknown>,sessionId?:string,options?:CdpSendOptions):Promise<any>;onEvent(listener:(method:string,params:any,sessionId?:string)=>void):()=>void;onClose(listener:()=>void):void;close():void}
/** Only Chrome's fixed local discovery file, never an agent-supplied URL/port/path. */
export function parseChromeActivePort(text:string):string {
 const lines=text.trim().split(/\r?\n/);if(lines.length!==2||!/^\d{1,5}$/.test(lines[0]!)||+lines[0]!<1||+lines[0]!>65535||!/^\/devtools\/browser\/[A-Za-z0-9-]{8,128}$/.test(lines[1]!))throw new Error('Chrome debugging endpoint is invalid.');
 return `ws://127.0.0.1:${Number(lines[0])}${lines[1]}`;
}
export async function chromeDebugEndpoint():Promise<string>{
 const root=chromeUserDataDir({});if(!root)throw new Error('Chrome is unavailable.');
 try{const data=await readFile(join(root,'DevToolsActivePort'));if(data.length>512)throw new Error();return parseChromeActivePort(data.toString('utf8'));}
 catch{throw new Error('Chrome에서 chrome://inspect/#remote-debugging을 열어 연결을 켜고, 연결 요청을 허용해 주세요.');}
}
/** A timed-out mutation is unknown. Closing rejects every pending command and invalidates every lease. */
export class WorkroomCdpTransport implements BrowserCdp {
 private socket:WebSocket;private next=0;private closed=false;private pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();private events=new Set<(m:string,p:any,s?:string)=>void>();private closers=new Set<()=>void>();
 private constructor(socket:WebSocket){this.socket=socket;socket.addEventListener('message',event=>{if(typeof event.data!=='string'||event.data.length>2_000_000){this.close();return;}let v:any;try{v=JSON.parse(event.data);}catch{this.close();return;}if(typeof v.id==='number'){const p=this.pending.get(v.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(v.id);v.error?p.reject(new Error('Chrome refused the bounded operation.')):p.resolve(v.result??{});}else if(typeof v.method==='string'){for(const fn of this.events)fn(v.method,v.params??{},v.sessionId);}});socket.addEventListener('close',()=>this.close());socket.addEventListener('error',()=>this.close());}
 static async connect(endpoint:string,timeout=120000):Promise<WorkroomCdpTransport>{
  if(!/^ws:\/\/127\.0\.0\.1:\d{1,5}\/devtools\/browser\/[A-Za-z0-9-]{8,128}$/.test(endpoint))throw new Error('Local Chrome endpoint required.');
  const socket=new WebSocket(endpoint);const transport=new WorkroomCdpTransport(socket);
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{transport.close();reject(new Error('Chrome 연결 승인이 완료되지 않았습니다.'));},timeout);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Chrome 연결을 확인해 주세요.'));},{once:true});socket.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('Chrome 연결이 종료됐습니다.'));},{once:true});});return transport;
 }
 send(method:string,params:Record<string,unknown>={},sessionId?:string,options:CdpSendOptions={}):Promise<any>{if(this.closed)return Promise.reject(new Error('Chrome disconnected.'));if(this.pending.size>=16)return Promise.reject(new Error('Browser queue full.'));const id=++this.next,read=options.read;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(!read){this.close();return;}const p=this.pending.get(id);if(p){this.pending.delete(id);p.reject(new Error('The page did not answer in time.'));}},read?Math.min(Math.max(read.timeoutMs,100),8000):8000);this.pending.set(id,{resolve,reject,timer});try{this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch{this.close();}});}
 onEvent(fn:(m:string,p:any,s?:string)=>void){this.events.add(fn);return()=>{this.events.delete(fn);};}
 onClose(fn:()=>void){if(this.closed)fn();else this.closers.add(fn);}
 close(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Chrome connection lost; mutation outcome may be unknown.'));}this.pending.clear();for(const fn of this.closers)fn();this.closers.clear();this.events.clear();this.socket.close();}
}
