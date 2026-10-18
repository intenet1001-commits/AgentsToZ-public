import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,writeFileSync,readdirSync,realpathSync,renameSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {CommonMemoryError} from './src/commonMemory';
import {planCommonMemoryProjects,validateCommonMemoryProjectPlan,type CommonMemoryLocalProject,type CommonMemoryProjectPlan} from './src/commonMemoryProjects';
import {FileProjectLaunchReceiptStore,projectLaunchDirectoryIdentity} from './src/projectLaunchReceipt';
type Root={workspaceRootId:string;name:string;path:string};
export function createCommonMemoryProjectManager(deps:{appDataDir:string;roots():Promise<Root[]>;sources(groupId:string):Promise<any>;inventory():Promise<CommonMemoryLocalProject[]>;lease<T>(root:string,task:()=>Promise<T>):Promise<T>;clone(url:string,path:string):Promise<void>;restore(path:string,member:CommonMemoryProjectPlan['members'][number],assertActive:()=>void,scopeId:string):Promise<void>;register(path:string,name:string,projectId:string,memoryId:string,githubUrl:string):Promise<void>}){
  const receipts=new FileProjectLaunchReceiptStore(deps.appDataDir);
  const rootFor=async(id:string)=>{const root=(await deps.roots()).find(r=>r.workspaceRootId===id);if(!root)throw new CommonMemoryError('COMMON_MEMORY_ROOT_CHANGED','등록된 작업 루트를 다시 선택하세요.');return root;};
  const plan=async(groupId:string,rootId:string)=>{
    const [root,source,local]=await Promise.all([rootFor(rootId),deps.sources(groupId),deps.inventory()]);
    return planCommonMemoryProjects({groupId,version:source.version,goalVersion:source.state.goalVersion,scopeId:source.scopeId,workspaceRootId:rootId,rootIdentity:projectLaunchDirectoryIdentity(root.path),sources:source.projects,local,occupied:readdirSync(root.path)});
  };
  const add=async(raw:unknown,requestId:string,memoryId:string,owner='local',assertActive=()=>{})=>{
    if(!/^[a-f0-9-]{36}$/i.test(requestId))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','추가 요청 ID를 확인하세요.',400);
    const wanted=await validateCommonMemoryProjectPlan(raw),root=await rootFor(wanted.workspaceRootId);
    return deps.lease(root.path,async()=>{
      assertActive();const fresh=await plan(wanted.groupId,wanted.workspaceRootId);
      if(wanted.version!==fresh.version||wanted.scopeId!==fresh.scopeId||wanted.rootIdentity!==fresh.rootIdentity||JSON.stringify(wanted.members.map(m=>[m.memoryId,m.revisionId,m.contentHash,m.githubUrl,m.folderName]))!==JSON.stringify(fresh.members.map(m=>[m.memoryId,m.revisionId,m.contentHash,m.githubUrl,m.folderName])))throw new CommonMemoryError('COMMON_MEMORY_PLAN_CHANGED','목표·원본·GitHub 주소·작업 루트가 바뀌었습니다. 추가 계획을 다시 확인하세요.');
      const outcomes:Array<{memoryId:string;name:string;state:string;message:string}>=[];
      if(!wanted.members.some(m=>m.memoryId===memoryId))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','추가할 프로젝트를 계획에서 선택하세요.',400);
      for(const member of wanted.members){
        const now=fresh.members.find(m=>m.memoryId===member.memoryId)!;
        if(now.status==='present'){outcomes.push({memoryId:member.memoryId,name:member.name,state:'present',message:now.message});continue;}
        if(member.status!=='missing'){outcomes.push({memoryId:member.memoryId,name:now.name,state:now.status==='missing'?'review-required':now.status,message:now.status==='missing'?'등록 상태가 바뀌었습니다. 추가 계획을 다시 확인하세요.':now.message});continue;}
        if(member.memoryId!==memoryId){outcomes.push({memoryId:member.memoryId,name:member.name,state:'pending',message:'다음 프로젝트 추가 대기'});continue;}
        if(now.status==='unavailable'||now.status==='conflict'&&!existsSync(join(root.path,member.folderName))){outcomes.push({memoryId:member.memoryId,name:member.name,state:now.status,message:now.message});continue;}
        assertActive();const fingerprint=createHash('sha256').update(wanted.planHash+'\0'+member.memoryId).digest('hex');
        const {receipt,created}=await receipts.reserve({controllerId:'common_'+createHash('sha256').update(owner).digest('hex'),requestId,fingerprint,workspaceRootId:wanted.workspaceRootId,rootIdentityHash:wanted.rootIdentity,expiresAt:new Date(Date.now()+30*86400_000).toISOString()});
        const target=join(realpathSync(root.path),member.folderName),marker=join(target,'.git','agentstoz-common-project-receipt');
        try{
          if(existsSync(target)){
            if(created||lstatSync(target).isSymbolicLink()||!existsSync(marker)||lstatSync(marker).isSymbolicLink()||readFileSync(marker,'utf8')!==receipt.projectId+':'+fingerprint)throw new CommonMemoryError('COMMON_MEMORY_PROJECT_CONFLICT','기존 폴더를 보존했습니다. 이전 추가 결과를 확인하세요.');
            if(receipt.projectIdentityHash&&receipt.projectIdentityHash!==projectLaunchDirectoryIdentity(target))throw new CommonMemoryError('COMMON_MEMORY_PROJECT_CONFLICT','이전에 추가한 폴더가 변경됐습니다.');
          }else{
            // Only a path owned by this attempt is removed on failure. Published projects are retained.
            const stage=join(root.path,'.agentstoz-common-clone-'+receipt.projectId);if(existsSync(stage))throw new CommonMemoryError('COMMON_MEMORY_PROJECT_RECOVERY_REQUIRED','중단된 Clone 폴더를 먼저 확인하세요.');
            try{assertActive();await deps.clone(member.githubUrl!,stage);assertActive();const gitDir=join(stage,'.git');if(!existsSync(gitDir)||lstatSync(gitDir).isSymbolicLink()||!lstatSync(gitDir).isDirectory())throw new Error('Git 저장소를 확인하지 못했습니다.');writeFileSync(join(gitDir,'agentstoz-common-project-receipt'),receipt.projectId+':'+fingerprint,{mode:0o600,flag:'wx'});renameSync(stage,target);}finally{if(existsSync(stage))rmSync(stage,{recursive:true,force:true});}
          }
          await receipts.record(receipt,'materialized',projectLaunchDirectoryIdentity(target));
          assertActive();await deps.restore(target,member,assertActive,wanted.scopeId);assertActive();const latest=await deps.sources(wanted.groupId);if(latest.version!==wanted.version||latest.scopeId!==wanted.scopeId||!latest.projects.some((p:any)=>p.memoryId===member.memoryId&&p.revisionId===member.revisionId&&p.contentHash===member.contentHash))throw new CommonMemoryError('COMMON_MEMORY_SOURCE_CHANGED','기억 복원 중 목표·원본이 바뀌었습니다. 가져온 폴더를 보존했으며 등록 결과를 확인해야 합니다.');
          const currentRoot=await rootFor(wanted.workspaceRootId);if(currentRoot.path!==root.path||projectLaunchDirectoryIdentity(currentRoot.path)!==wanted.rootIdentity)throw new CommonMemoryError('COMMON_MEMORY_ROOT_CHANGED','Clone 중 작업 루트가 변경됐습니다. 기존 폴더를 보존했습니다.');
          await deps.register(target,member.folderName,receipt.projectId,member.memoryId,member.githubUrl!);
          await receipts.record(receipt,'registered',projectLaunchDirectoryIdentity(target));
          outcomes.push({memoryId:member.memoryId,name:member.name,state:'added',message:'Clone·기존 장기기억 복원·프로젝트 등록 완료'});
        }catch(error){outcomes.push({memoryId:member.memoryId,name:member.name,state:'failed',message:error instanceof CommonMemoryError?error.message:'추가를 완료하지 못했습니다. 같은 요청으로 결과를 확인하세요.'});}
      }
      return {groupId:wanted.groupId,requestId,outcomes,complete:outcomes.every(o=>['present','added'].includes(o.state)),sourceMemoriesPreserved:true};
    });
  };
  const status=async(requestId:string,owner='local')=>{const row=await receipts.lookup('common_'+createHash('sha256').update(owner).digest('hex'),requestId);return {found:!!row,state:row?.state??null};};
  const owns=async(owner:string,projectId:string,rootId:string,rootIdentity:string,directoryIdentity:string)=>{const row=await receipts.findCreatedProject({controllerId:'common_'+createHash('sha256').update(owner).digest('hex'),projectId,workspaceRootId:rootId,rootIdentityHash:rootIdentity});return row?.projectIdentityHash===directoryIdentity;};
  const membersStatus=async(groupId:string)=>{const [source,local]=await Promise.all([deps.sources(groupId),deps.inventory()]);const result=await planCommonMemoryProjects({groupId,version:source.version,goalVersion:source.state.goalVersion,scopeId:source.scopeId,workspaceRootId:'status-only',rootIdentity:'0'.repeat(64),sources:source.projects,local,occupied:[]});return {groupId,version:source.version,scopeId:source.scopeId,members:result.members.map(({folderName,...m})=>m),missingCount:result.members.filter(m=>m.status==='missing').length,reviewCount:result.members.filter(m=>m.status==='unavailable'||m.status==='conflict').length};};
  return {membersStatus,plan,add,status,owns};
}
