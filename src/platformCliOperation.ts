import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readdirSync,rmSync} from 'node:fs';
import {readPrivateFileStrict,writePrivateFileAtomically} from './remoteControlHostVault';
import {withOwnedPortalFileLock} from './portalFileLock';
import {PlatformCliError,platformCliRequestId,type PlatformCliAccount,type PlatformCliProvider} from './platformCliProtocol';
import type {PlatformCliHost} from './platformCliHost';
import {connectNativePlatformAccount} from './platformCliSetup';
import {ONBOARDING_OPERATION_LOCK} from './onboardingOperationLock';
export interface PlatformCliOperationView {id:string;state:'waiting'|'completed'|'failed'|'interrupted';startedAt:number;provider?:PlatformCliProvider;label?:string;account?:PlatformCliAccount;message?:string}
interface RecordValue extends PlatformCliOperationView {hash:string}
/** Readback of one exact request survives WebView timeouts and app restarts. No secret is stored. */
export class PlatformCliOperations {
  private running=new Map<string,RecordValue>();
  constructor(private readonly host:PlatformCliHost){}
  busy(){return this.running.size>0;}
  private file(id:string){platformCliRequestId(id);return join(this.host.store.root,'connection-operation-'+id+'.json');}
  private view(record:RecordValue):PlatformCliOperationView {const {hash,...view}=record;return view;}
  status(id:string){
    const live=this.running.get(id);if(live)return this.view(live);
    const raw=readPrivateFileStrict(this.file(id));if(!raw||raw.length>8192)throw new PlatformCliError('이 확인 요청을 찾지 못했습니다. 기존 목록을 확인하세요.');
    const d=JSON.parse(raw) as RecordValue;
    if(d.id!==id||!['waiting','completed','failed'].includes(d.state))throw new PlatformCliError('확인 기록을 읽지 못했습니다.');
    return this.view(d.state==='waiting'?{...d,state:'interrupted',message:'앱이 다시 시작되어 확인이 중단되었습니다. 계정 목록을 확인한 뒤 다시 검사하세요. 자동 재로그인하지 않았습니다.'}:d);
  }
  async start(request:Record<string,any>){
    const id=platformCliRequestId(request.requestId),hash=createHash('sha256').update(JSON.stringify([request.operation,request.accountId,request.provider,request.email,request.purpose])).digest('hex');
    this.host.store.ensureDirectory();
    return withOwnedPortalFileLock(join(this.host.store.root,'connection-operation.lock'),()=>{
      const raw=readPrivateFileStrict(this.file(id));
      if(raw){if(JSON.parse(raw).hash!==hash)throw new PlatformCliError('같은 요청 ID를 다른 확인에 사용할 수 없습니다.');return this.status(id);}
      if(this.running.size)throw new PlatformCliError('진행 중인 계정 확인을 먼저 마치세요. macOS 키체인 확인창이 있으면 직접 승인한 뒤 같은 결과를 조회하세요.');
      let count=0;
      for(const name of readdirSync(this.host.store.root).filter(n=>/^connection-operation-[A-Za-z0-9_-]+\.json$/.test(n))){const file=join(this.host.store.root,name),old=JSON.parse(readPrivateFileStrict(file)??'null');if(!old)throw new PlatformCliError('확인 기록을 읽지 못했습니다.');if(old.state!=='waiting'&&old.startedAt<Date.now()-7*86_400_000)rmSync(file);else count++;}
      if(count>=128)throw new PlatformCliError('확인 기록 한도입니다. 기존 요청 결과를 먼저 확인하세요.');
      const account=request.operation==='check-start'?this.host.store.account(request.accountId):undefined;
      const label=account?.label??String(request.email??'').slice(0,120),provider=account?.provider??request.provider;
      const d:RecordValue={id,hash,state:'waiting',startedAt:Date.now(),provider,label};
      this.running.set(id,d);writePrivateFileAtomically(this.host.store.root,this.file(id),JSON.stringify(d));
      void this.execute(request,d).catch(()=>{this.running.delete(d.id);});return this.view(d);
    },{...ONBOARDING_OPERATION_LOCK,label:'CLI connection admission'});
  }
  private async execute(r:Record<string,any>,d:RecordValue){
    try{d.account=r.operation==='check-start'?await this.host.check(r.accountId,d.id):await connectNativePlatformAccount(this.host,r.provider,r.email,d.id,undefined,r.purpose);d.state='completed';}
    catch{d.state='failed';d.message='계정 연결을 확인하지 못했습니다. 키체인 승인·네트워크·권한을 확인하세요. 기존 계정은 유지됩니다.';}
    finally{writePrivateFileAtomically(this.host.store.root,this.file(d.id),JSON.stringify(d));this.running.delete(d.id);}
  }
}
