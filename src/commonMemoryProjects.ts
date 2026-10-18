import {CommonMemoryError,commonMemoryHash,type CommonMemorySourceHead} from './commonMemory';
import {parseGitCloneRequest} from './gitCloneRequest';
export type CommonMemoryProjectSource=CommonMemorySourceHead & {name:string;githubUrl:string|null};
export type CommonMemoryLocalProject={id:string;memoryId:string|null;githubUrl:string|null;available:boolean};
export type CommonMemoryProjectMember=CommonMemoryProjectSource & {folderName:string;status:'present'|'missing'|'conflict'|'unavailable';message:string};
export type CommonMemoryProjectPlan={schemaVersion:1;groupId:string;version:number;goalVersion:number;scopeId:string;workspaceRootId:string;rootIdentity:string;members:CommonMemoryProjectMember[];planHash:string};
/** Membership is memory identity, never a matching display name. No filesystem paths in the plan. */
export async function planCommonMemoryProjects(input:Omit<CommonMemoryProjectPlan,'schemaVersion'|'members'|'planHash'> & {sources:CommonMemoryProjectSource[];local:CommonMemoryLocalProject[];occupied:string[]}) :Promise<CommonMemoryProjectPlan>{
  if(input.sources.length>16)throw new CommonMemoryError('COMMON_MEMORY_BUDGET_EXCEEDED','프로젝트 묶음은 16개까지입니다.');
  const members=input.sources.map(source=>{
    const repo=parseGitCloneRequest(source.githubUrl??''),matching=input.local.filter(p=>p.memoryId===source.memoryId),sameRepo=input.local.filter(p=>repo&&parseGitCloneRequest(p.githubUrl??'')?.url.toLowerCase()===repo.url.toLowerCase());
    const folderName=repo?.repositoryName??'',base={...source,githubUrl:repo?.url??null,folderName};
    if(matching.some(p=>p.available))return {...base,status:'present' as const,message:matching.some(p=>repo&&parseGitCloneRequest(p.githubUrl??'')?.url.toLowerCase()!==repo.url.toLowerCase())?'이미 등록됨 · GitHub 주소 변경 확인 필요':'이 기기에 이미 등록됨'};
    if(matching.length)return {...base,status:'unavailable' as const,message:'등록된 폴더에 접근하지 못했습니다. 기존 등록을 확인하세요.'};
    if(!repo)return {...base,status:'unavailable' as const,message:'원본 장기기억에 GitHub 주소가 필요합니다.'};
    if(input.local.some(p=>!p.available&&!p.memoryId))return {...base,status:'unavailable' as const,message:'등록 프로젝트 조회를 완료하지 못했습니다. 다시 확인하세요.'};
    if(sameRepo.length)return {...base,status:'conflict' as const,message:'같은 저장소가 다른 기억으로 등록돼 있습니다. 계보를 확인하세요.'};
    if(input.sources.some(s=>s.memoryId!==source.memoryId&&parseGitCloneRequest(s.githubUrl??'')?.url.toLowerCase()===repo.url.toLowerCase()))return {...base,status:'conflict' as const,message:'여러 기억이 같은 저장소를 가리킵니다. 원본 계보를 먼저 확인하세요.'};
    if(input.occupied.some(name=>name.toLowerCase()===folderName.toLowerCase())||input.sources.some(s=>s.memoryId!==source.memoryId&&parseGitCloneRequest(s.githubUrl??'')?.repositoryName.toLowerCase()===folderName.toLowerCase()))return {...base,status:'conflict' as const,message:'같은 이름의 폴더가 있습니다. 다른 작업 루트를 선택하거나 기존 폴더를 등록하세요.'};
    return {...base,status:'missing' as const,message:'이 기기에 없음 · Clone하고 기존 장기기억 복원'};
  });
  const plan={schemaVersion:1 as const,groupId:input.groupId,version:input.version,goalVersion:input.goalVersion,scopeId:input.scopeId,workspaceRootId:input.workspaceRootId,rootIdentity:input.rootIdentity,members};
  return {...plan,planHash:await commonMemoryHash(JSON.stringify(plan))};
}
export async function validateCommonMemoryProjectPlan(raw:unknown):Promise<CommonMemoryProjectPlan>{
  const p=raw as CommonMemoryProjectPlan;
  if(!p||p.schemaVersion!==1||!Array.isArray(p.members)||!p.members.length||p.members.length>16||!Number.isSafeInteger(p.version)||p.version<1||!/^[a-f0-9]{64}$/.test(p.scopeId)||!/^[a-f0-9]{64}$/.test(p.rootIdentity))throw new CommonMemoryError('COMMON_MEMORY_INPUT_INVALID','프로젝트 추가 계획을 다시 확인하세요.',400);
  const {planHash,...body}=p;
  if(planHash!==await commonMemoryHash(JSON.stringify(body)))throw new CommonMemoryError('COMMON_MEMORY_PLAN_CHANGED','프로젝트 추가 계획이 변경됐습니다. 다시 조회하세요.');
  return p;
}
