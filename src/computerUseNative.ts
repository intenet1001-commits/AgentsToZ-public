import type {ComputerWorker,ComputerWorkerContext} from './computerUseHost';
import {COMPUTER_USE_WORKER_PROTOCOL,controlAdvertisesScreen,parseComputerTarget} from './computerUseProtocol';

export interface ComputerUseNativeChannel {
  readonly available:boolean;
  request(body:Record<string,unknown>):Promise<Record<string,any>>;
  dispose():void;
  retire?(body:Record<string,unknown>):void;
}
/**
 * Requests that may wait for a busy channel: status reads that change nothing in Control (the panel and an AI ask at
 * the same time every few seconds), and turning the standing allowance off, which only takes away and follows the
 * revocations that switching off queues just before it.
 */
const WAITING_READS=new Set(['status','scope-status','approval-status','scope-approval-status','scope-standing-off']);
/**
 * Input is never queued. Revocations wait for the current request, with priority over new input. A status read
 * waits a bounded time too: refusing it at once reported a busy channel as `scope-status-unavailable` (1호, 2026-10-31).
 */
export class RevokingComputerUseChannel implements ComputerUseNativeChannel {
  private active=false;
  private retirements=new Map<string,Record<string,unknown>>();
  private flushing=false;
  constructor(private readonly raw:ComputerUseNativeChannel,private readonly readWait={steps:10,ms:150}){}
  get available(){return this.raw.available;}
  async request(body:Record<string,unknown>){
    for(let step=0;this.active||this.flushing||this.retirements.size;step++){
      if(!WAITING_READS.has(String(body.operation))||step>=this.readWait.steps)throw Object.assign(Error('도우미 연결이 사용 중입니다.'),{notDispatched:true,code:'busy'});
      await new Promise(resolve=>setTimeout(resolve,this.readWait.ms));
    }
    this.active=true;try{return await this.raw.request(body);}finally{this.active=false;void this.flush();}
  }
  retire(body:Record<string,unknown>){
    if(!['revoke','revoke-session','scope-revoke','scope-revoke-session'].includes(String(body.operation))){this.dispose();return;}
    const key=JSON.stringify(body);
    if(this.retirements.size>=72&&!this.retirements.has(key)){this.dispose();return;}
    if(!this.available)return;this.retirements.set(key,body);void this.flush();
  }
  private async flush(){
    if(this.active||this.flushing||!this.available)return;this.flushing=true;
    try{for(const[key,body]of this.retirements){
      this.retirements.delete(key);
      try{const reply=await this.raw.request(body);if(reply.success!==true){this.dispose();break;}}
      catch{this.dispose();break;}
    }}finally{this.flushing=false;}
  }
  dispose(){this.retirements.clear();this.raw.dispose();}
}
/** This adapter never spawns a child. Only the main app's inherited channel can reach the signed Control app. */
export function nativeComputerWorker(channel:ComputerUseNativeChannel,context:ComputerWorkerContext):ComputerWorker {
  const caller={...context.caller,generation:context.generation};
  // Read from the open-grant answer of the Control that holds this grant: capture/click only if it lists them.
  let grant:string|null=null,closed=false,bindingMayExist=false,screen=false;
  const send=async(body:Record<string,unknown>)=>{
    try{return await channel.request(body);}
    catch(error){
      const safe=(error as {notDispatched?:boolean})?.notDispatched===true;
      if(!safe)channel.dispose();
      return {success:false,halted:!safe,notDispatched:safe,code:safe?((error as {code?:string})?.code==='busy'?'native-busy':'worker-unavailable'):'native-outcome-unknown'};
    }
  };
  return {
    supports:()=>screen,
    async request(body){
      if(closed)return {success:false,halted:true,notDispatched:true,code:'worker-halted'};
      if(body.operation==='bind'){
        if(grant||bindingMayExist)throw Error('제어 허용을 다시 열 수 없습니다.');
        if(JSON.stringify(parseComputerTarget(body.target))!==JSON.stringify(parseComputerTarget(context.target)))throw Error('승인 대상이 다릅니다.');
        bindingMayExist=true;
        const answer=await send({operation:'open-grant',approvalId:context.approvalId,target:context.target,caller});
        if(answer.success!==true){if(answer.notDispatched===true)bindingMayExist=false;return answer;}
        if(answer.bound!==true||answer.protocolVersion!==COMPUTER_USE_WORKER_PROTOCOL||typeof answer.grant!=='string'||!/^[a-f0-9]{32}$/.test(answer.grant)){
          channel.dispose();throw Error('네이티브 제어 허용을 확인하지 못했습니다.');
        }
        grant=answer.grant;screen=controlAdvertisesScreen(answer);
        if(closed){await send({operation:'revoke',grant,caller});return {success:false,halted:true,notDispatched:true,code:'worker-halted'};}
        return {success:true,bound:true,protocolVersion:answer.protocolVersion};
      }
      if(!grant)return {success:false,halted:true,notDispatched:true,code:'target-not-bound'};
      const operation=body.operation;
      if(!['observe','capture','click','press','set-value','receipt'].includes(String(operation)))throw Error('지원하지 않는 네이티브 동작입니다.');
      // An older Control would refuse these as requests it cannot decode; say why instead and send nothing.
      if((operation==='capture'||operation==='click')&&!screen)return {success:false,halted:false,notDispatched:true,code:'control-update-required'};
      const request:Record<string,unknown>={operation,grant,caller};
      if(operation!=='observe'&&operation!=='capture')request.requestId=body.requestId;
      if(operation==='capture')request.snapshotId=body.snapshotId;
      if(operation==='click')Object.assign(request,{snapshotId:body.snapshotId,x:body.x,y:body.y});
      if(operation==='press'||operation==='set-value')Object.assign(request,{snapshotId:body.snapshotId,element:body.element},operation==='set-value'?{value:body.value}:{});
      return send(request);
    },
    close(){
      if(closed)return;closed=true;
      if(grant){const request={operation:'revoke',grant,caller};
        if(channel.retire)channel.retire(request);else void send(request).then(answer=>{if(answer.success!==true)channel.dispose();});}
      else if(bindingMayExist)channel.dispose();
    },
  };
}
