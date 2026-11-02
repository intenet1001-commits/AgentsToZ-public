import {randomUUID} from 'node:crypto';
import {closeSync,read,write} from 'node:fs';
import {dirname,join} from 'node:path';
import {Duplex} from 'node:stream';

const MAX_REQUEST=16_384,MAX_RESPONSE=524_288;
const MAX_QUEUED=16,MAX_QUEUED_BYTES=131_072,MAX_TIMEOUT=120_000;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export class ComputerUseLinkError extends Error {
  constructor(readonly code:string,readonly notDispatched:boolean){super('컴퓨터 유즈 도우미 연결: '+code);}
}
export interface ComputerUseMainRequestOptions {
  signal?:AbortSignal;
  /** Waiting admission does not imply dispatch. A waiting timeout leaves the active operation alone. */
  queueTimeoutMs?:number;
  /** Host-only bounded deadline after the single write; never deserialized from a request body. */
  timeoutMs?:number;
}
type PendingRequest={id:string;bytes:Buffer;resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;
  timeoutMs:number;timer?:ReturnType<typeof setTimeout>;signal?:AbortSignal;abort?:()=>void};
/** One inherited channel, one write in flight, one bounded FIFO shared by every feature. Nothing is resent. */
export class ComputerUseMainLink {
  private buffer=Buffer.alloc(0);
  private closed=false;
  private pending?:PendingRequest;
  private queue:PendingRequest[]=[];
  private queuedBytes=0;
  constructor(private readonly stream:Duplex,private readonly timeoutMs=10_000,private readonly verifyMain?:()=>boolean){
    stream.on('data',(chunk:Buffer)=>this.receive(Buffer.from(chunk)));
    stream.on('error',()=>this.fail('transport-lost'));stream.on('end',()=>this.fail('parent-ended'));
    stream.on('close',()=>this.fail('transport-closed'));
  }
  get available(){return !this.closed;}
  /** Audit-token-bound installed, signed Main; rechecked for each remote admission. */
  get verifiedMain(){return !!this.verifyMain&&this.currentMain();}
  private currentMain():boolean{
    if(this.closed)return false;
    if(!this.verifyMain)return true; // Injectable test streams carry no installed-Main claim.
    let trusted=false;try{trusted=this.verifyMain()===true;}catch{}
    if(!trusted)this.fail('main-changed');return trusted&&!this.closed;
  }
  request(request:Record<string,unknown>,options:ComputerUseMainRequestOptions={}):Promise<Record<string,unknown>>{
    if(this.closed)return Promise.reject(new ComputerUseLinkError('unavailable',true));
    if(!this.currentMain())return Promise.reject(new ComputerUseLinkError('main-changed',true));
    const timeoutMs=options.timeoutMs??this.timeoutMs,queueTimeoutMs=options.queueTimeoutMs??this.timeoutMs;
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>MAX_TIMEOUT||!Number.isSafeInteger(queueTimeoutMs)||queueTimeoutMs<1||queueTimeoutMs>MAX_TIMEOUT)return Promise.reject(new ComputerUseLinkError('invalid-timeout',true));
    if(options.signal?.aborted)return Promise.reject(new ComputerUseLinkError('cancelled',true));
    const id=randomUUID();let bytes:Buffer;
    try{bytes=Buffer.from(JSON.stringify({version:1,id,request}));}catch{return Promise.reject(new ComputerUseLinkError('invalid-request',true));}
    if(this.closed)return Promise.reject(new ComputerUseLinkError('unavailable',true));
    if(bytes.length>MAX_REQUEST)return Promise.reject(new ComputerUseLinkError('request-too-large',true));
    if(this.queue.length>=MAX_QUEUED||this.queuedBytes+bytes.length>MAX_QUEUED_BYTES)return Promise.reject(new ComputerUseLinkError('busy',true));
    if(options.signal?.aborted)return Promise.reject(new ComputerUseLinkError('cancelled',true));
    return new Promise((resolve,reject)=>{
      // bytes are the immutable enqueue snapshot; later caller edits can neither change purpose nor append authority.
      const entry:PendingRequest={id,bytes,resolve,reject,timeoutMs,signal:options.signal};
      entry.timer=setTimeout(()=>this.removeWaiting(entry,'queue-timeout'),queueTimeoutMs);entry.timer.unref?.();
      entry.abort=()=>{if(this.pending===entry)this.fail('outcome-unknown');else this.removeWaiting(entry,'cancelled');};
      entry.signal?.addEventListener('abort',entry.abort,{once:true});
      this.queue.push(entry);this.queuedBytes+=bytes.length;this.pump();
    });
  }
  private clean(entry:PendingRequest){if(entry.timer)clearTimeout(entry.timer);entry.signal?.removeEventListener('abort',entry.abort!);}
  private removeWaiting(entry:PendingRequest,code:string){
    const index=this.queue.indexOf(entry);if(index<0)return;
    this.queue.splice(index,1);this.queuedBytes-=entry.bytes.length;this.clean(entry);entry.reject(new ComputerUseLinkError(code,true));this.pump();
  }
  private pump(){
    if(this.closed||this.pending||!this.queue.length)return;
    if(!this.currentMain())return;
    const entry=this.queue.shift()!;this.queuedBytes-=entry.bytes.length;
    clearTimeout(entry.timer);this.pending=entry;
    entry.timer=setTimeout(()=>this.fail('outcome-unknown'),entry.timeoutMs);entry.timer.unref?.();
    const header=Buffer.alloc(4);header.writeUInt32BE(entry.bytes.length);
    // write(false) means accepted under backpressure. A write error or cancellation is unknown, never a new write.
    try{this.stream.write(Buffer.concat([header,entry.bytes]),error=>{if(error)this.fail('transport-lost');});}
    catch{this.fail('transport-lost');}
  }
  private receive(chunk:Buffer){
    if(this.closed||!this.currentMain())return;
    if(!this.pending||this.buffer.length+chunk.length>MAX_RESPONSE+4){this.fail('invalid-response');return;}
    this.buffer=Buffer.concat([this.buffer,chunk]);
    if(this.buffer.length<4)return;
    const size=this.buffer.readUInt32BE(0);
    if(size<2||size>MAX_RESPONSE){this.fail('invalid-response');return;}
    if(this.buffer.length<size+4)return;
    if(this.buffer.length!==size+4){this.fail('unexpected-response');return;}
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(this.buffer.subarray(4)));}catch{this.fail('invalid-response');return;}
    if(!plain(value)||Object.keys(value).length!==3||value.version!==1||value.id!==this.pending.id||!plain(value.response)){
      this.fail('invalid-response');return;
    }
    const pending=this.pending;this.pending=undefined;this.buffer=Buffer.alloc(0);this.clean(pending);
    pending.resolve(value.response);
    this.pump();
  }
  private fail(code:string){
    if(this.closed)return;this.closed=true;this.buffer=Buffer.alloc(0);
    const pending=this.pending;this.pending=undefined;
    if(pending){this.clean(pending);pending.reject(new ComputerUseLinkError(code,false));}
    const queued=this.queue;this.queue=[];this.queuedBytes=0;
    for(const entry of queued){this.clean(entry);entry.reject(new ComputerUseLinkError(code==='outcome-unknown'?'unavailable':code,true));}
    this.stream.destroy();
  }
  dispose(){this.fail('closed');}
}

type PrivateSocketAddon={prepare:(descriptor:number)=>boolean;verifiedMain:(descriptor:number)=>boolean;stop:(descriptor:number)=>void};
/** fs.read/write support inherited socket descriptors in Bun 1.4.2; net.Socket({fd}) cannot read them. */
class InheritedSocketStream extends Duplex {
  private reading=false;
  constructor(private readonly descriptor:number,private readonly native:PrivateSocketAddon){super();}
  override _read(){
    if(this.reading||this.destroyed)return;this.reading=true;const buffer=Buffer.alloc(64*1024);
    read(this.descriptor,buffer,0,buffer.length,null,(error,size)=>{
      this.reading=false;if(this.destroyed)return;
      if(error){this.destroy(error);return;}
      this.push(size?buffer.subarray(0,size):null);
    });
  }
  override _write(buffer:Buffer,_encoding:BufferEncoding,done:(error?:Error|null)=>void){
    const send=(offset:number)=>{
      if(this.destroyed){done(Error('private-socket-closed'));return;}
      write(this.descriptor,buffer,offset,buffer.length-offset,null,(error,size)=>{
        if(error){done(error);return;}
        if(size<=0){done(Error('private-socket-stalled'));return;}
        if(offset+size<buffer.length)send(offset+size);else done();
      });
    };send(0);
  }
  override _destroy(error:Error|null,done:(error?:Error|null)=>void){
    try{this.native.stop(this.descriptor);}catch{}
    try{closeSync(this.descriptor);}catch{}
    done(error);
  }
}
function inheritedLink():ComputerUseMainLink|null{
  const raw=process.env.PORTMGR_COMPUTER_USE_FD;delete process.env.PORTMGR_COMPUTER_USE_FD;
  if(!raw)return null;
  if(!/^\d{1,6}$/.test(raw))return null;
  const descriptor=Number(raw);if(descriptor<3)return null;
  if(process.platform!=='darwin'||process.env.PORTMGR_BUNDLED_SIDECAR!=='1'){try{closeSync(descriptor);}catch{}return null;}
  try{
    // Stable Node-API, no variadic FFI or path from an environment/request. Mark close-on-exec synchronously,
    // before any provider or shell module can spawn. The inherited endpoint, not its number, is the authority.
    const native=require(join(dirname(process.execPath),'agentstoz-api-sidecar-control-link.node')) as PrivateSocketAddon;
    if(native.prepare(descriptor)!==true)throw Error('unsafe-private-socket');
    return new ComputerUseMainLink(new InheritedSocketStream(descriptor,native),10_000,()=>native.verifiedMain(descriptor));
  }catch{try{closeSync(descriptor);}catch{}return null;}
}
/** A missing channel is unsupported, including development. No file, HTTP token or caller boolean substitutes it. */
export const inheritedComputerUseMainLink=inheritedLink();
