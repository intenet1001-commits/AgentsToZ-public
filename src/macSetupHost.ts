import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {pathEntryExists,readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';
import {ONBOARDING_OPERATION_LOCK} from './onboardingOperationLock';
import {withOwnedPortalFileLock} from './portalFileLock';
import {MAC_SETUP_TOOLS,macSetupToolId,macSetupPending,macSetupPrerequisites,type MacSetupToolId,type MacSetupRow,type MacSetupView} from './macSetupCatalog';

export interface MacSetupEffects {
  probe(id:MacSetupToolId):Promise<MacSetupRow>;
  install(id:MacSetupToolId,signal:AbortSignal):Promise<void>;
  launch(id:MacSetupToolId,signal:AbortSignal):Promise<void>;
}
type Stored=MacSetupView&{ownerPid?:number;cancelRequested?:boolean;requestKey?:string};
const alive=(pid:number|undefined)=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}};
/** One device queue. Only metadata is durable; commands, credentials and CLI output never enter it. */
export class MacSetupHost {
  private controller:AbortController|null=null;
  private readonly root:string;private readonly file:string;
  constructor(appDirectory:string,private readonly effects:MacSetupEffects,private readonly supported=process.platform==='darwin'){
    this.root=join(appDirectory,'mac-setup');this.file=join(this.root,'progress.json');
  }
  private read():Stored {
    const raw=readPrivateFileStrict(this.file);
    if(!raw){if(pathEntryExists(this.file))throw Error('MAC_SETUP_UNREADABLE');return {schemaVersion:1,recipe:1,revision:0,requestId:null,active:false,rows:MAC_SETUP_TOOLS.map(t=>({id:t.id,state:'unknown',message:'아직 확인하지 않았습니다.'})),updatedAt:Date.now()};}
    const d=JSON.parse(raw) as Stored;
    if(raw.length>24_000||d.schemaVersion!==1||d.recipe!==1||!Number.isSafeInteger(d.revision)||!Array.isArray(d.rows)||d.rows.length!==MAC_SETUP_TOOLS.length||new Set(d.rows.map(r=>r.id)).size!==d.rows.length||d.rows.some(r=>!macSetupToolId(r.id)||!['unknown','missing','installed','running','checking','installing','needs-action','failed','cancelled'].includes(r.state)))throw Error('MAC_SETUP_RECORD');
    return d;
  }
  private save(d:Stored){d.revision++;d.updatedAt=Date.now();writePrivateFileAtomically(this.root,this.file,JSON.stringify(d));}
  status(){
    const d=this.read();
    if(d.active&&!alive(d.ownerPid)){
      d.active=false;
      d.rows=d.rows.map(r=>macSetupPending(r.state)?{...r,state:'needs-action',message:'앱이 다시 시작되었습니다. 다시 검사로 실제 결과를 확인한 뒤 이어가세요.'}:r);
    }
    const {ownerPid,cancelRequested,requestKey,...view}=d;return {supported:this.supported,view};
  }
  async act(value:Record<string,unknown>){
    if(!this.supported)throw Error('MAC_ONLY');
    const {operation,expectedRevision,requestId,selected}=value;
    if(!['inspect','start','cancel','launch','focus'].includes(String(operation))||!Number.isSafeInteger(expectedRevision))throw Error('MAC_SETUP_REQUEST');
    if(operation!=='cancel'&&(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{16,80}$/.test(requestId)))throw Error('MAC_SETUP_ID');
    const ids=selected as MacSetupToolId[]|undefined;
    if(operation==='start'||operation==='launch'||operation==='focus')if(!Array.isArray(ids)||!ids.length||ids.length>MAC_SETUP_TOOLS.length||new Set(ids).size!==ids.length||ids.some(id=>!macSetupToolId(id)))throw Error('MAC_SETUP_SELECTION');
    mkdirSync(this.root,{recursive:true,mode:0o700});
    return withOwnedPortalFileLock(this.file+'.lock',()=>{
      const d=this.read();
      if(d.active&&!alive(d.ownerPid)){
        d.active=false;d.rows=d.rows.map(r=>macSetupPending(r.state)?{...r,state:'needs-action',message:'중단된 결과를 다시 확인해야 합니다.'}:r);
      }
      const requestKey=createHash('sha256').update(JSON.stringify([operation,ids])).digest('hex');
      if(d.requestId===requestId&&operation!=='cancel'){if(d.requestKey!==requestKey)throw Error('MAC_SETUP_REPLAY');return this.status();}
      if(d.revision!==expectedRevision)throw Error('MAC_SETUP_STALE');
      if(operation==='focus'){
        if(ids!.length!==1||!['codex-app','claude-app'].includes(ids![0]!)||!d.rows.some(r=>r.id===ids![0]&&r.state==='running'))throw Error('MAC_SETUP_HELPER');
        // Opening an already verified helper neither interrupts nor replays the installation queue.
        return this.effects.launch(ids![0]!,new AbortController().signal).then(()=>this.status());
      }
      if(operation==='cancel'){
        if(d.active){d.cancelRequested=true;this.save(d);this.controller?.abort();}return this.status();
      }
      if(d.active)throw Error('MAC_SETUP_ACTIVE');
      if(operation==='start'&&d.rows.some(r=>ids!.includes(r.id)&&r.state==='needs-action'))throw Error('MAC_SETUP_READBACK_REQUIRED');
      d.active=true;d.ownerPid=process.pid;d.cancelRequested=false;d.requestId=requestId as string;d.requestKey=requestKey;this.save(d);
      this.controller=new AbortController();
      // Admission is short even while OS approval, a download or an app launch is pending.
      const workIds=operation==='start'?macSetupPrerequisites(ids!):ids??MAC_SETUP_TOOLS.map(t=>t.id);
      void this.work(d,operation as string,workIds,this.controller.signal).catch(()=>{
        d.active=false;d.rows=d.rows.map(r=>macSetupPending(r.state)?{...r,state:'failed',message:'결과를 확인하지 못했습니다. 다시 검사하세요.'}:r);this.save(d);
      });
      return this.status();
    },{...ONBOARDING_OPERATION_LOCK,label:'Mac preparation admission'});
  }
  private async work(d:Stored,operation:string,selected:MacSetupToolId[],signal:AbortSignal){
    const cancelled=()=>signal.aborted||this.read().cancelRequested===true;
    const update=(row:MacSetupRow)=>{d.cancelRequested=this.read().cancelRequested;d.rows=d.rows.map(r=>r.id===row.id?row:r);this.save(d);};
    for(const tool of MAC_SETUP_TOOLS.filter(t=>selected.includes(t.id))){
      if(cancelled())break;
      update({id:tool.id,state:'checking',message:'실제 설치·실행 상태 확인 중…'});
      try{
        let row=await this.effects.probe(tool.id);
        if(operation==='start'&&row.state==='missing'&&!cancelled()){
          update({id:tool.id,state:'installing',message:'공식 설치 진행 중… OS 확인창이 나타나면 직접 승인하세요.'});
          await this.effects.install(tool.id,signal);
          row=await this.effects.probe(tool.id);
          if(row.state==='missing')row={id:tool.id,state:'needs-action',message:'공식 설치 화면을 마친 뒤 다시 검사하세요. 설치 완료로 처리하지 않았습니다.'};
        }
        if(operation!=='inspect'&&tool.id.endsWith('-app')&&row.state==='installed'&&!cancelled()){
          update({id:tool.id,state:'checking',message:'앱 첫 실행 확인 중… macOS 승인창을 확인하세요.'});
          await this.effects.launch(tool.id,signal);row=await this.effects.probe(tool.id);
          if(row.state!=='running')row={...row,state:'needs-action',message:'앱 실행을 아직 확인하지 못했습니다. macOS 승인과 앱 화면을 확인한 뒤 다시 검사하세요.'};
        }
        update(row);
        // OS installers run outside our process. Wait for the person, never enqueue duplicates.
        if(operation!=='inspect'&&row.state==='needs-action')break;
      }catch{
        update({id:tool.id,state:cancelled()?'cancelled':'failed',message:cancelled()?'중지했습니다. 설치된 것은 보존합니다. 다시 검사한 뒤 이어가세요.':'설치·실행을 확인하지 못했습니다. 공식 안내와 OS 승인창을 확인한 뒤 다시 검사하세요.'});
      }
    }
    d.active=false;this.save(d);this.controller=null;
  }
}
