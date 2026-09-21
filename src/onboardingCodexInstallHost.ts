import {randomUUID} from 'node:crypto';
import {OnboardingProgressStore} from './onboardingProgressStore';
import {CODEX_INSTALL_RECIPE,parseCodexInstallReceipt,type CodexInstallReceipt} from './onboardingCodexInstall';

export class CodexInstallStore extends OnboardingProgressStore {
  constructor(directory:string){super(directory);this.db.exec('CREATE TABLE IF NOT EXISTS codex_install(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL)');}
  receipt():CodexInstallReceipt|null {
    const row=this.db.query('SELECT body FROM codex_install WHERE id=1').get() as {body:string}|null;
    if(!row)return null;
    if(row.body.length>4096)throw new Error('설치 기록 확인 필요');
    return parseCodexInstallReceipt(JSON.parse(row.body));
  }
  change(expected:string,fn:(r:CodexInstallReceipt|null)=>CodexInstallReceipt){
    return this.db.transaction(()=>{
      const r=this.receipt();if((r?.revision??'0')!==expected)throw new Error('설치 상태 변경됨');
      const next=parseCodexInstallReceipt({...fn(r),revision:randomUUID(),updatedAt:new Date().toISOString()});
      this.db.query('INSERT INTO codex_install(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(next));return next;
    }).immediate();
  }
}
export interface CodexInstallEffects {
  supported:boolean;
  probe:()=>Promise<'missing'|'installed'|'configured'|'unknown'>;
  prepare:(signal:AbortSignal)=>Promise<void>;
  install:(signal:AbortSignal)=>Promise<void>;
}
function alive(pid:number|null){if(!pid)return false;try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}}
export class CodexInstallHost {
  private task:Promise<void>|null=null;
  private abort:AbortController|null=null;
  private disposed=false;
  constructor(private store:CodexInstallStore,private effects:CodexInstallEffects){}
  status(){const receipt=this.store.receipt();return {supported:this.effects.supported,receipt,
    interrupted:!!receipt&&['preparing','installing'].includes(receipt.state)&&!alive(receipt.ownerPid)};}
  async act(operation:string,expected:string){
    if(this.disposed||!this.effects.supported)throw new Error('지원 환경 확인 필요');
    const r=this.store.receipt();if((r?.revision??'0')!==expected)throw new Error('설치 상태 변경됨');
    if(operation==='cancel'){
      if(r?.ownerPid&&r.ownerPid!==process.pid&&alive(r.ownerPid))throw new Error('다른 앱 작업 진행 중');
      this.abort?.abort();
      if(r)this.store.change(expected,x=>({...x!,state:'cancelled',ownerPid:null}));
      return this.status();
    }
    if(this.task||alive(r?.ownerPid??null))throw new Error('이전 작업 진행 중');
    if(operation==='review'){
      this.store.change(expected,()=>({schema:1,recipe:CODEX_INSTALL_RECIPE.id,revision:randomUUID(),state:'reviewed',
        reviewedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),ownerPid:null}));return this.status();
    }
    if(!r)throw new Error('설치 내용 검토 필요');
    if(operation==='check'){
      // Readback remains available for an old recipe. No installation or auth is replayed.
      const p=await this.effects.probe();
      this.store.change(expected,x=>({...x!,state:p==='configured'||p==='installed'?p:'needs-review',ownerPid:null}));return this.status();
    }
    if(operation!=='install'||r.recipe!==CODEX_INSTALL_RECIPE.id||r.state!=='reviewed'
      ||Date.now()<Date.parse(r.reviewedAt)||Date.now()-Date.parse(r.reviewedAt)>300000)throw new Error('설치 내용 재검토 필요');
    let current=this.store.change(expected,x=>({...x!,state:'preparing',ownerPid:process.pid}));
    const abort=new AbortController();this.abort=abort;
    this.task=(async()=>{
      try{
        let p=await this.effects.probe();if(abort.signal.aborted)return;
        if(p==='unknown')throw new Error('기존 환경 확인 필요');
        if(p==='missing'){
          await this.effects.prepare(abort.signal);if(abort.signal.aborted)return;
          current=this.store.change(current.revision,x=>({...x!,state:'installing'}));
          await this.effects.install(abort.signal);if(abort.signal.aborted)return;
          p=await this.effects.probe();
        }
        this.store.change(current.revision,x=>({...x!,state:p==='installed'||p==='configured'?p:'needs-review',ownerPid:null}));
      }catch{try{this.store.change(current.revision,x=>({...x!,state:'needs-review',ownerPid:null}));}catch{/* A newer cancellation owns the receipt. */}}
      finally{this.abort=null;this.task=null;}
    })();
    return this.status();
  }
  async close(){this.disposed=true;this.abort?.abort();await this.task;}
}
