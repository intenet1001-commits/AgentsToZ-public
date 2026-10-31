import {randomUUID} from 'node:crypto';
import {DesktopSessionEffort,DesktopEffortPreDispatchRefusal,type DesktopSessionEffortAdapter,type DesktopSessionEffortMode} from './desktopSessionEffort';
import {DESKTOP_EFFORT_ADAPTER_STATUS} from './desktopEffortNative';
export {DESKTOP_EFFORT_PATH} from './desktopEffortProtocol';
type Session={id:string;label:string;adapter:DesktopSessionEffortAdapter;control:DesktopSessionEffort;mode:DesktopSessionEffortMode;expiresAt:number;revision:number;configuring?:boolean;fixed?:string;minimum?:string;preserved?:string};
const plain=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Native connectors are registered by this trusted host, never by HTTP, MCP, a caller hint, or browser JavaScript. */
export class DesktopEffortHost {
  private sessions=new Map<string,Session>();
  constructor(private now=Date.now){}
  register(label:string,adapter:DesktopSessionEffortAdapter){
    if(this.sessions.size>=16)throw Error('외부 앱 세션 연결은 최대 16개입니다.');
    if([...this.sessions.values()].some(s=>s.adapter.binding.adapter===adapter.binding.adapter&&s.adapter.binding.sessionId===adapter.binding.sessionId))throw Error('이미 연결된 외부 앱 세션입니다.');
    const id='desktop_effort_'+randomUUID();let session:Session;
    const guarded:DesktopSessionEffortAdapter={binding:adapter.binding,capabilities:adapter.capabilities,read:()=>adapter.read(),set:async request=>{
      if(this.sessions.get(id)!==session||session.mode!=='auto'||session.expiresAt<=this.now())throw new DesktopEffortPreDispatchRefusal('이 세션의 자동 변경 동의가 끝났습니다.');
      const revision=session.revision,expiresAt=session.expiresAt;
      const authorized=()=>this.sessions.get(id)===session&&session.mode==='auto'&&session.revision===revision&&session.expiresAt===expiresAt&&expiresAt>this.now();
      await adapter.set({...request,validUntil:expiresAt,isAuthorized:authorized});
      if(!authorized())throw Error('변경 결과 확인 전에 동의가 끝났습니다.');
    }};
    session={id,label:label.slice(0,100),adapter:guarded,control:new DesktopSessionEffort(guarded),mode:'recommend',expiresAt:0,revision:1};this.sessions.set(id,session);return id;
  }
  unregister(id:string){const s=this.sessions.get(id);s?.control.manualChange();this.sessions.delete(id);}
  private session(id:unknown){const s=typeof id==='string'?this.sessions.get(id):null;if(!s)throw Error('외부 앱의 현재 세션을 다시 연결하세요.');return s;}
  async manage(value:unknown){
    if(!plain(value)||typeof value.operation!=='string')throw Error('외부 앱 에포트 요청을 확인하세요.');
    const exact=(keys:string[])=>{if(Object.keys(value).some(k=>!keys.includes(k)))throw Error('지원하지 않는 외부 앱 설정입니다.');};
    if(value.operation==='status'){
      exact(['operation']);this.expire();return {success:true,adapters:DESKTOP_EFFORT_ADAPTER_STATUS.map(a=>({...a,available:[...this.sessions.values()].some(s=>s.adapter.binding.adapter===a.id)})),sessions:[...this.sessions.values()].map(s=>({id:s.id,label:s.label,binding:{...s.adapter.binding},mode:s.mode,expiresAt:s.expiresAt,revision:s.revision,fixed:s.fixed,minimum:s.minimum,preserved:s.preserved}))};
    }
    if(value.operation==='configure'){
      exact(['operation','id','expectedRevision','mode','consent','allowLowering','fixed','minimum']);
      const s=this.session(value.id);
      if(!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1||value.mode!=='off'&&value.expectedRevision!==s.revision)throw Error('세션 설정이 바뀌었거나 변경 중입니다. 다시 확인하세요.');
      if(!['auto','recommend','off'].includes(value.mode)||value.allowLowering!==undefined&&typeof value.allowLowering!=='boolean')throw Error('자동 변경 설정을 확인하세요.');
      if(value.mode==='auto'&&value.consent!==true)throw Error('이 외부 앱 세션의 자동 변경에 별도로 동의해야 합니다.');
      const capabilities=s.adapter.capabilities;
      if(value.mode==='auto'&&(!capabilities.sessionOnly||!capabilities.compareAndSet||!capabilities.effectiveReadback))throw Error('이 연결은 세션 한정 자동 변경과 실제 적용 확인을 지원하지 않습니다.');
      if(value.consent!==undefined&&value.consent!==true)throw Error('세션 동의를 확인하세요.');
      if(value.fixed!==undefined&&typeof value.fixed!=='string'||value.minimum!==undefined&&typeof value.minimum!=='string')throw Error('고정 강도와 최소 강도를 확인하세요.');
      if(value.mode==='off'||value.mode==='recommend'){
        s.control.setSafeMode(value.mode,{...(value.fixed?{fixed:value.fixed}:{}),...(value.minimum?{minimum:value.minimum}:{})});
        s.fixed=value.fixed;s.minimum=value.minimum;s.preserved=undefined;s.mode=value.mode;s.expiresAt=0;s.revision++;return {success:true};
      }
      if(s.configuring)throw Error('세션 설정이 바뀌었거나 변경 중입니다. 다시 확인하세요.');
      const consentExpiresAt=value.mode==='auto'?this.now()+600000:0;
      s.configuring=true;
      try {
        const result=await s.control.configure(value.mode,{...(value.mode==='auto'?{consent:s.adapter.binding}:{}),...(value.fixed?{fixed:value.fixed}:{}),...(value.minimum?{minimum:value.minimum}:{}),allowLowering:value.allowLowering});
        if(this.sessions.get(s.id)!==s||s.revision!==value.expectedRevision||consentExpiresAt>0&&consentExpiresAt<=this.now()){s.control.manualChange();throw Error('설정 중 외부 앱 세션이나 동의 상태가 바뀌었습니다.');}
        s.fixed=value.fixed;s.minimum=value.minimum;s.preserved='preserved' in result?result.preserved:undefined;s.mode=value.mode;s.expiresAt=consentExpiresAt;s.revision++;return {success:true};
      } finally {s.configuring=false;}
    }
    if(value.operation==='disconnect'){exact(['operation','id']);this.unregister(this.session(value.id).id);return {success:true};}
    throw Error('지원하지 않는 외부 앱 에포트 동작입니다.');
  }
  private expire(){for(const s of this.sessions.values())if(s.mode==='auto'&&s.expiresAt<=this.now()){s.control.manualChange();s.mode='recommend';s.expiresAt=0;s.revision++;}}
  /** Trusted native request/phase event, not a new model call, background poll, or an agent-editable HTTP operation. */
  async boundary(id:string,input:{requestId:string;text:string;phase:'planning'|'implementation'|'verification'|'handoff'}){
    this.expire();const s=this.session(id);
    if(input.text.length>4000||!['planning','implementation','verification','handoff'].includes(input.phase))throw Error('작업 경계의 짧은 문맥만 전달하세요.');
    return s.control.transition(input);
  }
  dispose(){for(const id of this.sessions.keys())this.unregister(id);}
}
