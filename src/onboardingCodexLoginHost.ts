import {randomUUID} from 'node:crypto';
import {CODEX_LOGIN_RECIPE,isCodexLoginUrl,type CodexLoginReceipt} from './onboardingCodexLogin';
import {CodexLoginStore} from './onboardingCodexLoginStore';
export type CodexLoginProbe='signed-out'|'configured'|'unknown'|'storage-review';
export interface CodexLoginEffects {
 supported:boolean;probe:()=>Promise<CodexLoginProbe>;
 login:(receipt:CodexLoginReceipt,onUrl:(url:string)=>void)=>{done:Promise<void>;cancel:()=>void};
 open:(url:string)=>Promise<void>;
}
function alive(pid:number|null){if(!pid)return false;try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}}
const state=(p:CodexLoginProbe):CodexLoginReceipt['state']=>p==='signed-out'?'ready-to-login':p==='unknown'?'needs-review':p;
export class CodexLoginHost {
 private task:Promise<void>|null=null;private stop:(()=>void)|null=null;private url:string|null=null;private disposed=false;
 constructor(private store:CodexLoginStore,private effects:CodexLoginEffects){}
 status(){const receipt=this.store.receipt();return {supported:this.effects.supported,receipt,browserReady:!!this.url&&receipt?.state==='authenticating',
  interrupted:receipt?.state==='authenticating'&&!alive(receipt.ownerPid)};}
 async act(operation:string,expected:string){
  if(this.disposed||!this.effects.supported)throw new Error('지원 환경 확인 필요');
  const r=this.store.receipt();if((r?.revision??'0')!==expected)throw new Error('로그인 상태 변경됨');
  if(operation==='open-login'){
   if(!this.task||!this.url||r?.state!=='authenticating'||!isCodexLoginUrl(this.url))throw new Error('로그인 준비 필요');
   await this.effects.open(this.url);return this.status();
  }
  if(operation==='cancel'){
   if(r?.ownerPid&&r.ownerPid!==process.pid&&alive(r.ownerPid))throw new Error('다른 앱에서 진행 중');
   this.url=null;this.stop?.();if(r)this.store.change(expected,x=>({...x!,state:'cancelled',ownerPid:null}));return this.status();
  }
  if(this.task||alive(r?.ownerPid??null)||alive(r?.guardPid??null))throw new Error('이전 로그인 종료 확인 중');
  if(operation==='review'||operation==='check'){
   const p=await this.effects.probe();this.store.change(expected,()=>({schema:1,recipe:CODEX_LOGIN_RECIPE,id:randomUUID(),revision:randomUUID(),state:state(p),
    checkedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),ownerPid:null,guardPid:null}));return this.status();
  }
  if(operation!=='login'||!r||r.recipe!==CODEX_LOGIN_RECIPE||r.state!=='ready-to-login'
   ||Date.now()<Date.parse(r.checkedAt)||Date.now()-Date.parse(r.checkedAt)>300000)throw new Error('로그인 상태 재확인 필요');
  const p=await this.effects.probe();
  if(p!=='signed-out'){this.store.change(expected,x=>({...x!,state:state(p)}));return this.status();}
  let current=this.store.change(expected,x=>({...x!,state:'authenticating',ownerPid:process.pid,guardPid:null}));
  this.url=null;
  let login:ReturnType<CodexLoginEffects['login']>;
  try{login=this.effects.login(current,url=>{const r=this.store.receipt();if(r?.id===current.id&&r.state==='authenticating'&&isCodexLoginUrl(url))this.url=url;});}
  catch{this.store.change(current.revision,x=>({...x!,state:'needs-review',ownerPid:null}));return this.status();}
  this.stop=login.cancel;
  this.task=(async()=>{
   try{
    await login.done;
    const r=this.store.receipt();if(r?.id!==current.id||r.state!=='authenticating')return;
    const after=await this.effects.probe(),latest=this.store.receipt();
    if(latest?.id===current.id&&latest.state==='authenticating')this.store.change(latest.revision,x=>({...x!,state:after==='configured'||after==='storage-review'?after:'needs-review',ownerPid:null,guardPid:null}));
   }catch{const r=this.store.receipt();if(r?.id===current.id&&r.state==='authenticating'){try{this.store.change(r.revision,x=>({...x!,state:'needs-review',ownerPid:null,guardPid:null}));}catch{}}}
   finally{
    this.url=null;this.stop=null;this.task=null;
    const latest=this.store.receipt();if(latest?.id===current.id&&latest.state==='cancelled'){try{this.store.change(latest.revision,x=>({...x!,guardPid:null,ownerPid:null}));}catch{}}
   }
  })();return this.status();
 }
 async close(){this.disposed=true;this.url=null;this.stop?.();await this.task;}
}
