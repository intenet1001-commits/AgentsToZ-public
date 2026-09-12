import {createHash} from 'node:crypto';
import {mkdirSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {readPrivateFileStrict,writePrivateFileAtomically,pathEntryExists} from './remoteControlHostVault';
import {withOwnedPortalFileLock} from './portalFileLock';
import type {MobileWorkspaceResult} from './mobileWorkspaceProtocol';
type Outcome=NonNullable<MobileWorkspaceResult['memory']>;
type Receipt={schema:1;id:string;target:string;at:number;result:Outcome};
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
/** Persist admission before AI runs. Unconfirmed receipts are never replayed after restart. */
export class MobileWorkspaceJobs {
  private live=new Set<string>();
  constructor(private directory:string){}
  private read(id:string):Receipt|null {
    const raw=readPrivateFileStrict(join(this.directory,id+'.json'));if(raw===null){if(pathEntryExists(join(this.directory,id+'.json')))throw new Error('저장 영수증을 읽을 수 없습니다.');return null;}
    if(raw.length>4096)throw new Error('저장 작업 기록을 확인하세요.');
    const r=JSON.parse(raw) as Receipt;
    if(r.schema!==1||r.id!==id||!/^\w{64}$/.test(r.target)||!Number.isFinite(r.at)||!r.result||typeof r.result.state!=='string'||typeof r.result.message!=='string'||typeof r.result.localSaved!=='boolean'||typeof r.result.backupSaved!=='boolean')throw new Error('저장 작업 기록을 확인하세요.');
    return r;
  }
  private rows():Receipt[]{
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const files=readdirSync(this.directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f));
    if(files.length>128)throw new Error('모바일 저장 작업 보관 한도를 확인하세요.');
    return files.map(f=>this.read(f.slice(0,-5))!).filter(Boolean);
  }
  private outcome(r:Receipt):Outcome {
    return r.result.state==='saving'&&!this.live.has(r.id)?{state:'recovery-required',localSaved:false,backupSaved:false,message:'이전 저장의 완료 결과를 확인하지 못했습니다. Mac의 세션 저장 복구에서 확인하세요. 자동으로 다시 실행하지 않습니다.'}:r.result;
  }
  status(owner:string,targetId:string):Outcome {
    const target=digest(JSON.stringify([owner,targetId]));
    const row=this.rows().filter(r=>r.target===target).sort((a,b)=>b.at-a.at)[0];
    return row?this.outcome(row):{state:'idle',localSaved:false,backupSaved:false,message:'이 모바일 연결에서 요청한 저장이 없습니다.'};
  }
  async start(owner:string,targetId:string,requestId:string,run:()=>Promise<Outcome>):Promise<Outcome>{
    mkdirSync(this.directory,{recursive:true,mode:0o700});
    const id=digest(JSON.stringify([owner,requestId])),target=digest(JSON.stringify([owner,targetId]));
    return withOwnedPortalFileLock(join(this.directory,'admission.lock'),()=>{
      const existing=this.read(id);
      if(existing){if(existing.target!==target)throw new Error('저장 요청 대상이 변경되었습니다.');return this.outcome(existing);}
      const rows=this.rows(),pending=rows.find(r=>r.target===target&&['saving','recovery-required'].includes(r.result.state));
      if(pending)return this.outcome(pending);
      if(rows.length>=128)throw new Error('모바일 저장 기록 한도에 도달했습니다. Mac에서 저장 상태를 확인하세요.');
      if(this.live.size>=1)throw new Error('다른 모바일 저장이 진행 중입니다. 완료 후 다시 요청하세요.');
      const receipt:Receipt={schema:1,id,target,at:Date.now(),result:{state:'saving',localSaved:false,backupSaved:false,message:'세션 기억 저장 중입니다. 화면을 이동해도 작업은 계속됩니다.'}};
      writePrivateFileAtomically(this.directory,join(this.directory,id+'.json'),JSON.stringify(receipt));
      this.live.add(id);
      void Promise.resolve().then(run).then(result=>{receipt.result=result;writePrivateFileAtomically(this.directory,join(this.directory,id+'.json'),JSON.stringify(receipt));}).catch(()=>{
        receipt.result={state:'recovery-required',localSaved:false,backupSaved:false,message:'저장 완료를 확인하지 못했습니다. Mac의 세션 기억 상태와 복구 안내를 확인하세요.'};
        try{writePrivateFileAtomically(this.directory,join(this.directory,id+'.json'),JSON.stringify(receipt));}catch{/* Admission remains unconfirmed; never replay it. */}
      }).finally(()=>this.live.delete(id));
      return receipt.result;
    });
  }
}
