import {randomUUID} from 'node:crypto';
import {closeSync,read,write} from 'node:fs';
import {dirname,join} from 'node:path';
import {Duplex} from 'node:stream';

const MAX_REQUEST=16_384,MAX_RESPONSE=524_288;
const plain=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export class ComputerUseLinkError extends Error {
  constructor(readonly code:string,readonly notDispatched:boolean){super('컴퓨터 유즈 도우미 연결: '+code);}
}
/** One private inherited channel, one request in flight. Neither timeout nor transport loss is replayed. */
export class ComputerUseMainLink {
  private buffer=Buffer.alloc(0);
  private closed=false;
  private pending?:{id:string;resolve:(v:Record<string,unknown>)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>};
  constructor(private readonly stream:Duplex,private readonly timeoutMs=10_000){
    stream.on('data',(chunk:Buffer)=>this.receive(Buffer.from(chunk)));
    stream.on('error',()=>this.fail('transport-lost'));stream.on('end',()=>this.fail('parent-ended'));
    stream.on('close',()=>this.fail('transport-closed'));
  }
  get available(){return !this.closed;}
  request(request:Record<string,unknown>):Promise<Record<string,unknown>>{
    if(this.closed)return Promise.reject(new ComputerUseLinkError('unavailable',true));
    if(this.pending)return Promise.reject(new ComputerUseLinkError('busy',true));
    const id=randomUUID();let bytes:Buffer;
    try{bytes=Buffer.from(JSON.stringify({version:1,id,request}));}catch{return Promise.reject(new ComputerUseLinkError('invalid-request',true));}
    if(bytes.length>MAX_REQUEST)return Promise.reject(new ComputerUseLinkError('request-too-large',true));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail('outcome-unknown'),this.timeoutMs);timer.unref?.();
      this.pending={id,resolve,reject,timer};
      const header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);
      // write(false) means accepted under backpressure, not refused. The same request must never be resent.
      try{this.stream.write(Buffer.concat([header,bytes]),error=>{if(error)this.fail('transport-lost');});}
      catch{this.fail('transport-lost');}
    });
  }
  private receive(chunk:Buffer){
    if(this.closed)return;
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
    const pending=this.pending;this.pending=undefined;this.buffer=Buffer.alloc(0);clearTimeout(pending.timer);
    pending.resolve(value.response);
  }
  private fail(code:string){
    if(this.closed)return;this.closed=true;this.buffer=Buffer.alloc(0);
    const pending=this.pending;this.pending=undefined;
    if(pending){clearTimeout(pending.timer);pending.reject(new ComputerUseLinkError(code,false));}
    this.stream.destroy();
  }
  dispose(){this.fail('closed');}
}

type PrivateSocketAddon={prepare:(descriptor:number)=>boolean;stop:(descriptor:number)=>void};
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
    return new ComputerUseMainLink(new InheritedSocketStream(descriptor,native));
  }catch{try{closeSync(descriptor);}catch{}return null;}
}
/** A missing channel is unsupported, including development. No file, HTTP token or caller boolean substitutes it. */
export const inheritedComputerUseMainLink=inheritedLink();
